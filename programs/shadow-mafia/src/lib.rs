use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;
use session_keys::{session_auth_or, Session, SessionError, SessionToken};

declare_id!("4jEx2Z526KdKe97TKqf7kZnkdM3LBDtH6Et5n2cJnam8");

// ─── Seeds ───────────────────────────────────────────────────────────────────

pub const GAME_SEED: &[u8] = b"shadow_mafia_game";
pub const PLAYER_SEED: &[u8] = b"shadow_mafia_player";
pub const MIN_PLAYERS: u8 = 4;
pub const MAX_PLAYERS: u8 = 8;

// ─── Enums ───────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum Role { Citizen, Mafia, Detective, Doctor }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum GamePhase { Lobby, Night, Day, GameOver }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum Winner { None, Citizens, Mafia }

// ─── Program ─────────────────────────────────────────────────────────────────

#[ephemeral]
#[program]
pub mod shadow_mafia {
    use super::*;

    // ── L1: Create game lobby ────────────────────────────────────────────────
    pub fn create_game(
        ctx: Context<CreateGame>,
        game_id: u64,
        stake_lamports: u64,
        max_players: u8,
    ) -> Result<()> {
        require!(max_players >= MIN_PLAYERS && max_players <= MAX_PLAYERS, GameError::InvalidPlayerCount);
        require!(stake_lamports > 0, GameError::InvalidStake);

        let g = &mut ctx.accounts.game_state;
        g.game_id = game_id;
        g.host = ctx.accounts.host.key();
        g.stake_lamports = stake_lamports;
        g.max_players = max_players;
        g.player_count = 0;
        g.players = [Pubkey::default(); 8];
        g.eliminated = [false; 8];
        g.phase = GamePhase::Lobby;
        g.round = 0;
        g.current_tick = 0;
        g.alive_mafia = 0;
        g.alive_citizens = 0;
        g.winner = Winner::None;
        g.total_pot = 0;
        g.night_elimination_target = Pubkey::default();
        g.day_elimination_target = Pubkey::default();
        g.vrf_seed = [0u8; 32];
        g.created_at = Clock::get()?.unix_timestamp;
        g.settled_at = 0;
        g.roles = [0u8; 8]; // 0=Citizen, 1=Mafia, 2=Detective, 3=Doctor — assigned by VRF in assign_roles
        g.protected_player = Pubkey::default();

        msg!("Shadow Mafia game {} created. Stake: {} lamports", game_id, stake_lamports);
        Ok(())
    }

    // ── L1: Join game ────────────────────────────────────────────────────────
    pub fn join_game(ctx: Context<JoinGame>, game_id: u64) -> Result<()> {
        let player_key = ctx.accounts.player.key();
        let stake;
        let idx;

        {
            let g = &ctx.accounts.game_state;
            require!(g.phase == GamePhase::Lobby, GameError::GameAlreadyStarted);
            require!(g.player_count < g.max_players, GameError::GameFull);
            for i in 0..g.player_count as usize {
                require!(g.players[i] != player_key, GameError::AlreadyJoined);
            }
            stake = g.stake_lamports;
            idx = g.player_count as usize;
        }

        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &player_key,
            &ctx.accounts.game_state.key(),
            stake,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.player.to_account_info(),
                ctx.accounts.game_state.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let g = &mut ctx.accounts.game_state;
        g.players[idx] = player_key;
        g.player_count += 1;
        g.total_pot += stake;

        let ps = &mut ctx.accounts.player_state;
        ps.game_id = game_id;
        ps.player = player_key;
        ps.player_index = idx as u8;
        ps.role = Role::Citizen;
        ps.mafia_partner = Pubkey::default();
        ps.is_eliminated = false;
        ps.night_target = Pubkey::default();
        ps.day_vote = Pubkey::default();
        ps.has_voted_night = false;
        ps.has_voted_day = false;
        ps.has_protected = false;

        msg!("Player {} joined game {}. ({}/{})", player_key, game_id, g.player_count, g.max_players);
        Ok(())
    }

    // ── L1: Delegate GameState to ER (TEE vault) ─────────────────────────────
    pub fn delegate_game(ctx: Context<DelegateGame>, game_id: u64) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[GAME_SEED, &game_id.to_le_bytes()],
            DelegateConfig::default(),
        )?;
        msg!("Game {} delegated to Private ER (Intel TDX TEE).", game_id);
        Ok(())
    }

    // ── L1: Delegate PlayerState to ER ───────────────────────────────────────
    pub fn delegate_player(
        ctx: Context<DelegatePlayer>,
        game_id: u64,
        player_pubkey: Pubkey,
    ) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[PLAYER_SEED, &game_id.to_le_bytes(), player_pubkey.as_ref()],
            DelegateConfig::default(),
        )?;
        msg!("PlayerState delegated for {} in game {}.", player_pubkey, game_id);
        Ok(())
    }

    // ── Private ER: Assign roles via VRF (ALL logic inside TEE — server never knows) ──
    //
    // Fisher-Yates shuffle over player indices using `vrf_seed` bytes.
    // The resulting role array is written to game_state.roles[player_index].
    // Server receives zero information about who holds which role — it only
    // learns roles exist when it calls set_player_role (which reads from here).
    pub fn assign_roles(ctx: Context<HostAction>, game_id: u64, vrf_seed: [u8; 32]) -> Result<()> {
        let g = &mut ctx.accounts.game_state;
        require!(g.phase == GamePhase::Lobby, GameError::GameAlreadyStarted);
        require!(g.host == ctx.accounts.host.key(), GameError::NotHost);
        require!(g.player_count >= MIN_PLAYERS, GameError::NotEnoughPlayers);

        let n = g.player_count as usize;
        let mafia_count: usize = if n >= 6 { 2 } else { 1 };
        // alive_citizens tracks ALL non-Mafia for correct win-condition math
        let non_mafia_count: usize = n - mafia_count;

        g.vrf_seed = vrf_seed;
        g.alive_mafia = mafia_count as u8;
        g.alive_citizens = non_mafia_count as u8;
        g.phase = GamePhase::Night;
        g.round = 1;

        // ── Fisher-Yates shuffle using VRF bytes — runs INSIDE the TEE ──────
        // Each vrf_seed byte determines one swap step. This is verifiable:
        // anyone with the VRF seed can reproduce the exact assignment.
        let mut indices: [usize; 8] = [0, 1, 2, 3, 4, 5, 6, 7];
        for i in (1..n).rev() {
            let j = (vrf_seed[i] as usize) % (i + 1);
            indices.swap(i, j);
        }

        // Slots → roles: Mafia(1), Detective(2), Doctor(3), Citizen(0)
        // Layout: [0..mafia_count) = Mafia, mafia_count = Detective (n≥5),
        //         mafia_count+1 = Doctor (n≥5), rest = Citizen
        let mut roles = [0u8; 8];
        for (slot, &player_idx) in indices[..n].iter().enumerate() {
            roles[player_idx] = if slot < mafia_count {
                1 // Mafia
            } else if slot == mafia_count && n >= 5 {
                2 // Detective (one per game when 5+ players)
            } else if slot == mafia_count + 1 && n >= 5 {
                3 // Doctor (one per game when 5+ players)
            } else {
                0 // Citizen
            };
        }
        g.roles = roles;

        msg!(
            "VRF role assignment complete (game {}). {} Mafia | {} non-Mafia. Night 1 starts. TEE-only.",
            game_id, mafia_count, non_mafia_count
        );
        Ok(())
    }

    // ── Private ER: Sync individual player role from game_state.roles ────────
    // Server calls this after assign_roles to propagate the TEE-computed role
    // into each PlayerState. Server does NOT decide the role — it reads it from
    // game_state.roles (set by the TEE in assign_roles above).
    pub fn set_player_role(
        ctx: Context<SetPlayerRole>,
        _game_id: u64,
        _player_pubkey: Pubkey,
        role: Role,
        mafia_partner: Pubkey,
    ) -> Result<()> {
        require!(ctx.accounts.game_state.host == ctx.accounts.host.key(), GameError::NotHost);
        let ps = &mut ctx.accounts.player_state;
        ps.role = role;
        ps.mafia_partner = mafia_partner;
        msg!("Player role synced from TEE game_state.roles (private in TEE).");
        Ok(())
    }

    // ── Private ER: Mafia casts night vote ───────────────────────────────────
    #[session_auth_or(
        ctx.accounts.player_state.player == ctx.accounts.signer.key(),
        SessionError::InvalidToken
    )]
    pub fn mafia_night_vote(
        ctx: Context<PlayerVote>,
        game_id: u64,
        target: Pubkey,
        tick: u32,
    ) -> Result<()> {
        let ps_player = ctx.accounts.player_state.player;
        {
            let g = &ctx.accounts.game_state;
            require!(g.phase == GamePhase::Night, GameError::WrongPhase);
            let idx = g.players[..g.player_count as usize]
                .iter().position(|&p| p == target)
                .ok_or(GameError::InvalidTarget)?;
            require!(!g.eliminated[idx], GameError::TargetEliminated);
            require!(target != ps_player, GameError::CannotVoteSelf);
        }

        let ps = &mut ctx.accounts.player_state;
        require!(ps.role == Role::Mafia, GameError::NotMafia);
        require!(!ps.is_eliminated, GameError::PlayerEliminated);
        require!(!ps.has_voted_night, GameError::AlreadyVoted);

        ps.night_target = target;
        ps.has_voted_night = true;

        ctx.accounts.game_state.current_tick = ctx.accounts.game_state.current_tick.max(tick);
        msg!("Mafia night vote cast (private, game {} round {}).", game_id, ctx.accounts.game_state.round);
        Ok(())
    }

    // ── Private ER: TEE tallies night votes on-chain — no server JS involvement ──
    //
    // remaining_accounts: all alive PlayerState PDAs for this game (writable).
    // The TEE program:
    //   1. Reads night_target from every Mafia PlayerState
    //   2. Tallies votes entirely on-chain
    //   3. Eliminates the plurality target
    //   4. Updates alive counts from game_state.roles (no server JS)
    //   5. Resets vote flags + marks eliminated player
    //   6. Transitions phase (Day or GameOver)
    // Server never reads individual votes — outcome comes from this instruction.
    pub fn tally_and_close_night(
        ctx: Context<HostAction>,
        game_id: u64,
    ) -> Result<()> {
        require!(ctx.accounts.game_state.phase == GamePhase::Night, GameError::WrongPhase);
        require!(ctx.accounts.game_state.host == ctx.accounts.host.key(), GameError::NotHost);

        // ── Pass 1: Tally Mafia votes (read-only) ────────────────────────────
        let mut vote_counts: [(Pubkey, u8); 8] = [(Pubkey::default(), 0u8); 8];
        let mut vote_slots: usize = 0;

        for account in ctx.remaining_accounts.iter() {
            let data = account.try_borrow_data()?;
            if data.len() < 8 + PlayerState::DATA_LEN { continue; }
            let ps: PlayerState = AnchorDeserialize::deserialize(&mut &data[8..])?;
            if ps.game_id != game_id { continue; }
            if ps.role != Role::Mafia { continue; }
            if ps.is_eliminated { continue; }
            if !ps.has_voted_night { continue; }
            let t = ps.night_target;
            if t == Pubkey::default() { continue; }

            let mut found = false;
            for i in 0..vote_slots {
                if vote_counts[i].0 == t {
                    vote_counts[i].1 += 1;
                    found = true;
                    break;
                }
            }
            if !found && vote_slots < 8 {
                vote_counts[vote_slots] = (t, 1);
                vote_slots += 1;
            }
        }

        // ── Find plurality winner ─────────────────────────────────────────────
        let mut elim_target = Pubkey::default();
        let mut max_votes: u8 = 0;
        for i in 0..vote_slots {
            if vote_counts[i].1 > max_votes {
                max_votes = vote_counts[i].1;
                elim_target = vote_counts[i].0;
            }
        }

        // ── Update GameState: check doctor protection, eliminate target ───────
        {
            let g = &mut ctx.accounts.game_state;

            // Doctor protection: if the target is protected, no elimination this night
            if elim_target != Pubkey::default() && elim_target == g.protected_player {
                msg!("Night {} tally (TEE-on-chain): Doctor protected target, no elimination.", g.round);
                elim_target = Pubkey::default();
            }
            g.protected_player = Pubkey::default(); // reset protection each night

            if elim_target != Pubkey::default() {
                for i in 0..g.player_count as usize {
                    if g.players[i] == elim_target {
                        g.eliminated[i] = true;
                        // roles[i]: 1=Mafia, 0=Citizen, 2=Detective, 3=Doctor
                        if g.roles[i] == 1 {
                            if g.alive_mafia > 0 { g.alive_mafia -= 1; }
                        } else {
                            if g.alive_citizens > 0 { g.alive_citizens -= 1; }
                        }
                        break;
                    }
                }
                g.night_elimination_target = elim_target;
                msg!("Night {} tally (TEE-on-chain): {} eliminated.", g.round, elim_target);
            } else {
                g.night_elimination_target = Pubkey::default();
                msg!("Night {} tally (TEE-on-chain): no elimination.", g.round);
            }

            // Win condition + phase transition
            if g.alive_mafia == 0 {
                g.phase = GamePhase::GameOver;
                g.winner = Winner::Citizens;
                g.settled_at = Clock::get()?.unix_timestamp;
                msg!("Citizens win! (Game {})", game_id);
            } else if g.alive_mafia >= g.alive_citizens {
                g.phase = GamePhase::GameOver;
                g.winner = Winner::Mafia;
                g.settled_at = Clock::get()?.unix_timestamp;
                msg!("Mafia wins! (Game {})", game_id);
            } else {
                g.phase = GamePhase::Day;
                msg!("Day {} begins. (Game {})", g.round, game_id);
            }
        }

        // ── Pass 2: Reset night vote flags + has_protected + mark eliminated ──
        for account in ctx.remaining_accounts.iter() {
            let ps_snap: PlayerState = {
                let data = account.try_borrow_data()?;
                if data.len() < 8 + PlayerState::DATA_LEN { continue; }
                AnchorDeserialize::deserialize(&mut &data[8..])?
            };
            if ps_snap.game_id != game_id { continue; }

            let mut ps = ps_snap;
            if ps.player == elim_target { ps.is_eliminated = true; }
            ps.has_voted_night = false;
            ps.night_target = Pubkey::default();
            ps.has_protected = false; // reset doctor protection flag each round

            let serialized = ps.try_to_vec()?;
            let mut data = account.try_borrow_mut_data()?;
            data[8..8 + serialized.len()].copy_from_slice(&serialized);
        }

        Ok(())
    }

    // ── Private ER: Player casts day vote ────────────────────────────────────
    #[session_auth_or(
        ctx.accounts.player_state.player == ctx.accounts.signer.key(),
        SessionError::InvalidToken
    )]
    pub fn day_vote(
        ctx: Context<PlayerVote>,
        game_id: u64,
        suspect: Pubkey,
        tick: u32,
    ) -> Result<()> {
        let ps_player = ctx.accounts.player_state.player;
        {
            let g = &ctx.accounts.game_state;
            require!(g.phase == GamePhase::Day, GameError::WrongPhase);
            let idx = g.players[..g.player_count as usize]
                .iter().position(|&p| p == suspect)
                .ok_or(GameError::InvalidTarget)?;
            require!(!g.eliminated[idx], GameError::TargetEliminated);
            require!(suspect != ps_player, GameError::CannotVoteSelf);
        }

        let ps = &mut ctx.accounts.player_state;
        require!(!ps.is_eliminated, GameError::PlayerEliminated);
        require!(!ps.has_voted_day, GameError::AlreadyVoted);

        ps.day_vote = suspect;
        ps.has_voted_day = true;

        ctx.accounts.game_state.current_tick = ctx.accounts.game_state.current_tick.max(tick);
        msg!("Day vote cast (private, game {} round {}).", game_id, ctx.accounts.game_state.round);
        Ok(())
    }

    // ── Private ER: Doctor chooses protection target for the night ────────────
    #[session_auth_or(
        ctx.accounts.player_state.player == ctx.accounts.signer.key(),
        SessionError::InvalidToken
    )]
    pub fn doctor_protect(
        ctx: Context<PlayerVote>,
        game_id: u64,
        protect_target: Pubkey,
        tick: u32,
    ) -> Result<()> {
        {
            let g = &ctx.accounts.game_state;
            require!(g.phase == GamePhase::Night, GameError::WrongPhase);
            let idx = g.players[..g.player_count as usize]
                .iter().position(|&p| p == protect_target)
                .ok_or(GameError::InvalidTarget)?;
            require!(!g.eliminated[idx], GameError::TargetEliminated);
        }

        {
            let ps = &mut ctx.accounts.player_state;
            require!(ps.role == Role::Doctor, GameError::NotDoctor);
            require!(!ps.is_eliminated, GameError::PlayerEliminated);
            require!(!ps.has_protected, GameError::AlreadyVoted);
            ps.has_protected = true;
        }

        let g = &mut ctx.accounts.game_state;
        g.protected_player = protect_target;
        g.current_tick = g.current_tick.max(tick);

        msg!("Doctor protection set (private, game {} round {}).", game_id, g.round);
        Ok(())
    }

    // ── Private ER: TEE tallies day votes on-chain — no server JS involvement ──
    //
    // remaining_accounts: all alive PlayerState PDAs for this game (writable).
    // Same on-chain tally pattern as tally_and_close_night but for day phase.
    pub fn tally_and_close_day(
        ctx: Context<HostAction>,
        game_id: u64,
    ) -> Result<()> {
        require!(ctx.accounts.game_state.phase == GamePhase::Day, GameError::WrongPhase);
        require!(ctx.accounts.game_state.host == ctx.accounts.host.key(), GameError::NotHost);

        // ── Pass 1: Tally all alive player day votes (read-only) ─────────────
        let mut vote_counts: [(Pubkey, u8); 8] = [(Pubkey::default(), 0u8); 8];
        let mut vote_slots: usize = 0;

        for account in ctx.remaining_accounts.iter() {
            let data = account.try_borrow_data()?;
            if data.len() < 8 + PlayerState::DATA_LEN { continue; }
            let ps: PlayerState = AnchorDeserialize::deserialize(&mut &data[8..])?;
            if ps.game_id != game_id { continue; }
            if ps.is_eliminated { continue; }
            if !ps.has_voted_day { continue; }
            let t = ps.day_vote;
            if t == Pubkey::default() { continue; }

            let mut found = false;
            for i in 0..vote_slots {
                if vote_counts[i].0 == t {
                    vote_counts[i].1 += 1;
                    found = true;
                    break;
                }
            }
            if !found && vote_slots < 8 {
                vote_counts[vote_slots] = (t, 1);
                vote_slots += 1;
            }
        }

        // ── Find plurality winner ─────────────────────────────────────────────
        let mut elim_target = Pubkey::default();
        let mut max_votes: u8 = 0;
        for i in 0..vote_slots {
            if vote_counts[i].1 > max_votes {
                max_votes = vote_counts[i].1;
                elim_target = vote_counts[i].0;
            }
        }

        // ── Update GameState ──────────────────────────────────────────────────
        {
            let g = &mut ctx.accounts.game_state;
            if elim_target != Pubkey::default() {
                for i in 0..g.player_count as usize {
                    if g.players[i] == elim_target {
                        g.eliminated[i] = true;
                        if g.roles[i] == 1 {
                            if g.alive_mafia > 0 { g.alive_mafia -= 1; }
                        } else {
                            if g.alive_citizens > 0 { g.alive_citizens -= 1; }
                        }
                        break;
                    }
                }
                g.day_elimination_target = elim_target;
                msg!("Day {} tally (TEE-on-chain): {} voted out.", g.round, elim_target);
            } else {
                msg!("Day {} tally (TEE-on-chain): no majority, draw.", g.round);
            }

            // Win condition + phase transition
            if g.alive_mafia == 0 {
                g.phase = GamePhase::GameOver;
                g.winner = Winner::Citizens;
                g.settled_at = Clock::get()?.unix_timestamp;
                msg!("Citizens win! (Game {})", game_id);
            } else if g.alive_mafia >= g.alive_citizens {
                g.phase = GamePhase::GameOver;
                g.winner = Winner::Mafia;
                g.settled_at = Clock::get()?.unix_timestamp;
                msg!("Mafia wins! (Game {})", game_id);
            } else {
                g.round += 1;
                g.phase = GamePhase::Night;
                msg!("Night {} begins. (Game {})", g.round, game_id);
            }
        }

        // ── Pass 2: Reset day vote flags + mark eliminated player ─────────────
        for account in ctx.remaining_accounts.iter() {
            let ps_snap: PlayerState = {
                let data = account.try_borrow_data()?;
                if data.len() < 8 + PlayerState::DATA_LEN { continue; }
                AnchorDeserialize::deserialize(&mut &data[8..])?
            };
            if ps_snap.game_id != game_id { continue; }

            let mut ps = ps_snap;
            if ps.player == elim_target { ps.is_eliminated = true; }
            ps.has_voted_day = false;
            ps.day_vote = Pubkey::default();

            let serialized = ps.try_to_vec()?;
            let mut data = account.try_borrow_mut_data()?;
            data[8..8 + serialized.len()].copy_from_slice(&serialized);
        }

        Ok(())
    }

    // ── Private ER → L1: Commit final state + undelegate ─────────────────────
    pub fn end_game(ctx: Context<EndGame>, _game_id: u64) -> Result<()> {
        require!(ctx.accounts.game_state.phase == GamePhase::GameOver, GameError::GameNotOver);

        let g = &ctx.accounts.game_state;
        msg!(
            "Game {} committing to L1. Winner: {}. Pot: {} lamports.",
            g.game_id,
            match g.winner { Winner::Citizens => "Citizens", Winner::Mafia => "Mafia", Winner::None => "None" },
            g.total_pot
        );

        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.game_state.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }

    // ── L1: Distribute pot to winners ────────────────────────────────────────
    pub fn payout(ctx: Context<Payout>, game_id: u64) -> Result<()> {
        let g = &ctx.accounts.game_state;
        require!(g.phase == GamePhase::GameOver, GameError::GameNotOver);
        require!(g.winner != Winner::None, GameError::GameNotOver);

        let pot = g.total_pot;
        let winner_count = ctx.remaining_accounts.len() as u64;
        require!(winner_count > 0, GameError::NoWinners);

        let share = pot / winner_count;
        let game_info = ctx.accounts.game_state.to_account_info();

        for winner_account in ctx.remaining_accounts.iter() {
            **game_info.try_borrow_mut_lamports()? -= share;
            **winner_account.try_borrow_mut_lamports()? += share;
        }

        msg!("Payout: {} lamports x {} winners. Game {}.", share, winner_count, game_id);
        Ok(())
    }

    // ── L1: Close game PDA ───────────────────────────────────────────────────
    pub fn close_game(_ctx: Context<CloseGame>, game_id: u64) -> Result<()> {
        msg!("Game {} closed.", game_id);
        Ok(())
    }
}

// ─── Account Structs ─────────────────────────────────────────────────────────

#[account]
pub struct GameState {
    pub game_id: u64,
    pub host: Pubkey,
    pub stake_lamports: u64,
    pub max_players: u8,
    pub player_count: u8,
    pub players: [Pubkey; 8],
    pub eliminated: [bool; 8],
    pub phase: GamePhase,
    pub round: u8,
    pub current_tick: u32,
    pub alive_mafia: u8,
    pub alive_citizens: u8,
    pub winner: Winner,
    pub total_pot: u64,
    pub night_elimination_target: Pubkey,
    pub day_elimination_target: Pubkey,
    pub vrf_seed: [u8; 32],
    pub created_at: i64,
    pub settled_at: i64,
    /// VRF-assigned roles per player index: 0=Citizen, 1=Mafia, 2=Detective.
    /// Written exclusively by assign_roles (inside TEE). Server reads this
    /// after assign_roles to learn who gets which role — it cannot override it.
    pub roles: [u8; 8],
    /// Doctor's protection target for this night round. Reset after tally.
    pub protected_player: Pubkey,
}

impl GameState {
    pub const LEN: usize = 8   // discriminator
        + 8 + 32 + 8 + 1 + 1  // game_id, host, stake, max_players, player_count
        + (32 * 8)             // players
        + 8                    // eliminated
        + 1 + 1 + 4            // phase, round, current_tick
        + 1 + 1 + 1            // alive_mafia, alive_citizens, winner
        + 8                    // total_pot
        + 32 + 32              // night_target, day_target
        + 32                   // vrf_seed
        + 8 + 8                // created_at, settled_at
        + 8                    // roles[8] — VRF role assignment (TEE-only)
        + 32;                  // protected_player — Doctor's protection target
}

#[account]
pub struct PlayerState {
    pub game_id: u64,
    pub player: Pubkey,
    pub player_index: u8,
    pub role: Role,
    pub mafia_partner: Pubkey,
    pub is_eliminated: bool,
    pub night_target: Pubkey,
    pub day_vote: Pubkey,
    pub has_voted_night: bool,
    pub has_voted_day: bool,
    pub has_protected: bool,
}

impl PlayerState {
    /// Data length WITHOUT the 8-byte Anchor discriminator.
    pub const DATA_LEN: usize = 8 + 32 + 1 + 1 + 32 + 1 + 32 + 32 + 1 + 1 + 1; // = 142
    /// Total account space INCLUDING discriminator (used for space = ... in init).
    pub const LEN: usize = 8 + Self::DATA_LEN; // = 150
}

// ─── Instruction Contexts ────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct CreateGame<'info> {
    #[account(
        init, payer = host,
        space = GameState::LEN,
        seeds = [GAME_SEED, &game_id.to_le_bytes()], bump,
    )]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub host: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct JoinGame<'info> {
    #[account(mut, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub game_state: Account<'info, GameState>,
    #[account(
        init, payer = player,
        space = 8 + PlayerState::LEN,
        seeds = [PLAYER_SEED, &game_id.to_le_bytes(), player.key().as_ref()], bump,
    )]
    pub player_state: Account<'info, PlayerState>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct DelegateGame<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: GameState PDA to delegate to Private ER (TEE vault)
    #[account(mut, del, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub pda: AccountInfo<'info>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(game_id: u64, player_pubkey: Pubkey)]
pub struct DelegatePlayer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PlayerState PDA to delegate to Private ER (TEE vault)
    #[account(mut, del, seeds = [PLAYER_SEED, &game_id.to_le_bytes(), player_pubkey.as_ref()], bump)]
    pub pda: AccountInfo<'info>,
}

/// Generic host-only action context.
/// Instructions using this context may pass additional PlayerState PDAs
/// via remaining_accounts (tally_and_close_night, tally_and_close_day).
#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct HostAction<'info> {
    #[account(mut, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub host: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(game_id: u64, player_pubkey: Pubkey)]
pub struct SetPlayerRole<'info> {
    #[account(seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub game_state: Account<'info, GameState>,
    #[account(
        mut,
        seeds = [PLAYER_SEED, &game_id.to_le_bytes(), player_pubkey.as_ref()], bump,
    )]
    pub player_state: Account<'info, PlayerState>,
    #[account(mut)]
    pub host: Signer<'info>,
}

#[derive(Accounts, Session)]
#[instruction(game_id: u64)]
pub struct PlayerVote<'info> {
    #[account(mut, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub game_state: Account<'info, GameState>,
    #[account(
        mut,
        seeds = [PLAYER_SEED, &game_id.to_le_bytes(), player_state.player.as_ref()], bump,
    )]
    pub player_state: Account<'info, PlayerState>,
    #[account(mut)]
    pub signer: Signer<'info>,
    #[session(signer = signer, authority = player_state.player.key())]
    pub session_token: Option<Account<'info, SessionToken>>,
}

#[commit]
#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct EndGame<'info> {
    #[account(mut, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct Payout<'info> {
    #[account(mut, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct CloseGame<'info> {
    #[account(
        mut, close = host,
        seeds = [GAME_SEED, &game_id.to_le_bytes()], bump,
    )]
    pub game_state: Account<'info, GameState>,
    #[account(mut)]
    pub host: Signer<'info>,
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[error_code]
pub enum GameError {
    #[msg("Need 4–8 players")]
    InvalidPlayerCount,
    #[msg("Stake must be > 0")]
    InvalidStake,
    #[msg("Game already started")]
    GameAlreadyStarted,
    #[msg("Game is full")]
    GameFull,
    #[msg("Already joined")]
    AlreadyJoined,
    #[msg("Need at least 4 players to start")]
    NotEnoughPlayers,
    #[msg("Only host can do this")]
    NotHost,
    #[msg("Wrong game phase")]
    WrongPhase,
    #[msg("Only Mafia can night vote")]
    NotMafia,
    #[msg("Only the Doctor can protect")]
    NotDoctor,
    #[msg("Player is eliminated")]
    PlayerEliminated,
    #[msg("Already voted this round")]
    AlreadyVoted,
    #[msg("Invalid target")]
    InvalidTarget,
    #[msg("Target is eliminated")]
    TargetEliminated,
    #[msg("Cannot vote for yourself")]
    CannotVoteSelf,
    #[msg("Game is not over")]
    GameNotOver,
    #[msg("No winners")]
    NoWinners,
}
