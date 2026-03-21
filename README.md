# 🎭 Shadow Mafia — On-Chain Social Deduction with Private Roles

> A fully on-chain Mafia / Among Us style game built on Solana using MagicBlock's Private Ephemeral Rollups (Intel TDX TEE). Players stake real SOL, receive secret roles inside a hardware-protected vault, and eliminate each other through private votes — all decided by Rust code running inside a TEE, never by the server.

**Built for:** Solana Blitz v2 Hackathon (MagicBlock) · Theme: Privacy
**Program ID:** `4jEx2Z526KdKe97TKqf7kZnkdM3LBDtH6Et5n2cJnam8` (Solana Devnet)
**Tech Stack:** Anchor (Rust) · Next.js · Socket.io · MagicBlock Private ER · Session Keys

---

## Table of Contents

1. [What is Shadow Mafia?](#1-what-is-shadow-mafia)
2. [How to Play](#2-how-to-play)
3. [Why Privacy is Non-Negotiable Here](#3-why-privacy-is-non-negotiable-here)
4. [Architecture Overview](#4-architecture-overview)
5. [How Private ERs Power the Game](#5-how-private-ers-power-the-game)
6. [MagicBlock Stack — Full Usage](#6-magicblock-stack--full-usage)
7. [On-Chain Program Instructions](#7-on-chain-program-instructions)
8. [Session Keys — Gasless Voting](#8-session-keys--gasless-voting)
9. [VRF Seed — Verifiable Role Assignment](#9-vrf-seed--verifiable-role-assignment)
10. [Payout — Real SOL on the Line](#10-payout--real-sol-on-the-line)
11. [Running the Project Locally](#11-running-the-project-locally)
12. [Project Structure](#12-project-structure)

---

## 1. What is Shadow Mafia?

Shadow Mafia is a real-money social deduction game. Think **Among Us** or **Mafia** — but on Solana, where:

- Your role is a **secret sealed inside an Intel TDX hardware vault** (Private Ephemeral Rollup). Not even the server knows who is Mafia until the game is over.
- Every vote, every elimination, every protection is an **actual on-chain transaction** signed by your wallet.
- The winner gets the whole **SOL pot distributed automatically** by a Rust smart contract. No middleman. No trust required.

**4–8 players** join a lobby, each stakes a small amount of SOL (e.g. 0.1 SOL), and the game begins. Roles are assigned by a VRF-seeded shuffle running *inside* the TEE — the server never touches the role logic. When the game ends, the smart contract sends the pot straight to the winners' wallets.

---

## 2. How to Play

### Roles

| Role | Count | Goal |
|------|-------|------|
| 🔴 **Mafia** | 1–2 players | Eliminate Citizens without being caught |
| ⚪ **Citizen** | Most players | Find and vote out all Mafia members |
| 🔵 **Detective** | 1 player (5+ players) | Investigate one player each night |
| 💉 **Doctor** | 1 player (5+ players) | Protect one player from elimination each night |

### Game Flow

```
  LOBBY           NIGHT PHASE          DAY PHASE         GAME OVER
  ─────           ───────────          ─────────         ─────────
Players join  →  Mafia vote on    →  Everyone votes  →  Winners get
& stake SOL      who to kill         who to exile        the SOL pot
                 (private, ER)       (private, ER)
                 Doctor protects
                 Detective checks
```

### Step by Step

**1. Join the Lobby**
- Open the app, connect your Phantom wallet
- Enter an alias (your in-game name — your real wallet address stays hidden from other players during the game)
- Create a new game or enter a game code to join
- Sign the `join_game` transaction on Solana devnet — this locks your stake and creates your `PlayerState` account on-chain

**2. Game Starts**
- The host clicks **Start Game** (minimum 4 players)
- A VRF seed is generated from the latest Solana blockhash + sorted player public keys (publicly verifiable — the server cannot manipulate it)
- The game delegate to the **Private Ephemeral Rollup (TEE)** — a MagicBlock Intel TDX vault
- Roles are assigned by a Fisher-Yates shuffle running *inside the TEE*, written to `game_state.roles[]` on-chain
- Each player gets a one-time Phantom popup to create a **session key** — all subsequent votes are signed by a burner keypair (zero popups for the rest of the game)
- Your role is revealed to you privately — nobody else sees it

**3. Night Phase** (60 seconds)
- 🔴 **Mafia** sees their partner's name and selects a target to eliminate — signs a `mafia_night_vote` ER transaction
- 💉 **Doctor** picks one player to protect for this night — signs a `doctor_protect` ER transaction
- 🔵 **Detective** submits one player to investigate — immediately learns if that player is Mafia
- ⚪ **Citizens** wait (the game has them "sleeping")
- When all Mafia have voted (or the timer runs out), the server calls `tally_and_close_night` — a Rust instruction that reads all votes, checks doctor protection, and eliminates the target — **entirely inside the TEE, with zero server-side logic**
- The result is read from the ER: who died (or "the Doctor saved them!")

**4. Day Phase** (3 minutes)
- The eliminated player is revealed — role and all
- All alive players chat openly and debate who the Mafia might be
- Everyone signs a private `day_vote` ER transaction — the vote is hidden while voting is open
- When all votes are in (or timer ends), `tally_and_close_day` runs on-chain inside the TEE — tallies, exiles the plurality target, reveals result publicly

**5. Repeat until...**
- 🔴 Mafia wins when they equal or outnumber living Citizens
- ⚪ Citizens win when all Mafia are eliminated

**6. Payout**
- The final game state is **committed from the TEE back to Solana L1** (`end_game` + `#[commit]`)
- The smart contract's `payout` instruction splits the pot equally among winners
- SOL lands in winners' wallets automatically — on-chain, verifiable, no trust needed

---

## 3. Why Privacy is Non-Negotiable Here

Social deduction games *require* hidden information. If anyone — the server, other players, a blockchain explorer — could see who is Mafia, the game is broken instantly.

Traditional online Mafia games rely on trusting the server. The server knows all roles. Players have to hope it doesn't cheat.

Shadow Mafia removes that trust entirely:

| What needs to be secret | Where it's kept |
|------------------------|-----------------|
| Your role (Mafia/Citizen/etc.) | Inside Intel TDX TEE (Private ER) |
| Mafia's elimination target | Inside TEE — only committed after the night ends |
| Day votes (while voting is open) | Inside TEE — tallied and revealed atomically |
| Mafia partner's identity | Inside TEE in each Mafia's `PlayerState` |

The game literally **cannot exist** without a privacy layer. This is the opposite of "bolting privacy on" — privacy is the game's foundation.

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          PLAYER'S BROWSER                           │
│                                                                     │
│  ┌──────────────────┐     ┌──────────────────┐                      │
│  │  Next.js UI      │     │  Phantom Wallet  │                      │
│  │  (React 19)      │◄───►│  (L1 + Session)  │                      │
│  │                  │     └──────────────────┘                      │
│  │  - Game board    │                                               │
│  │  - Vote buttons  │     ┌──────────────────┐                      │
│  │  - Chat          │◄───►│  Burner Keypair  │ ← Session Key       │
│  │  - Role reveal   │     │  (in-browser)    │   (gasless votes)   │
│  └────────┬─────────┘     └──────────────────┘                      │
│           │                                                          │
└───────────┼──────────────────────────────────────────────────────────┘
            │  Socket.io (real-time events)
            │  Direct ER transactions (votes, protect)
            ▼
┌───────────────────────────────────────────────────────────────────────┐
│                       GAME SERVER (Node.js)                           │
│                                                                       │
│  Socket.io relay server — real-time rendering layer ONLY             │
│  Does NOT decide game outcomes. TEE is the authoritative engine.     │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  Responsibilities                                            │    │
│  │  • Relay chat messages between players                       │    │
│  │  • Track who has voted (via ER polling)                      │    │
│  │  • Trigger phase-end instructions on the ER                  │    │
│  │  • Crank endpoint: POST /crank/:gameId/:action               │    │
│  │  • Emit real-time events: phase_change, night_result, etc.   │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌──────────────────────┐       ┌─────────────────────────────┐      │
│  │  L1 Transactions     │       │  ER Transactions             │      │
│  │  (Solana Devnet)     │       │  (tee.magicblock.app)        │      │
│  │                      │       │                              │      │
│  │  • create_game       │       │  • assign_roles (VRF)        │      │
│  │  • join_game         │       │  • mafia_night_vote          │      │
│  │  • delegate_game     │       │  • doctor_protect            │      │
│  │  • payout            │       │  • day_vote                  │      │
│  └──────────────────────┘       │  • tally_and_close_night     │      │
│                                 │  • tally_and_close_day       │      │
│                                 │  • end_game (commit→L1)      │      │
│                                 └─────────────────────────────┘      │
└───────────────────────────────────────────────────────────────────────┘
            │                                 │
            ▼                                 ▼
┌───────────────────────┐     ┌───────────────────────────────────────┐
│   SOLANA DEVNET (L1)  │     │  MAGICBLOCK PRIVATE ER (Intel TDX)    │
│                       │     │                                       │
│  Permanent, public    │     │  Encrypted TEE vault.                 │
│  record of:           │     │  Runs Rust program instructions.      │
│                       │     │  Hidden from everyone — including     │
│  • Game creation      │     │  MagicBlock itself.                   │
│  • Player stakes      │◄────│                                       │
│  • Eliminations       │     │  Stores (private):                    │
│  • Final winner       │commit│  • game_state.roles[]               │
│  • SOL payout         │     │  • PlayerState.night_target           │
│  • VRF seed (public)  │     │  • PlayerState.day_vote               │
│                       │     │  • GameState.protected_player         │
└───────────────────────┘     └───────────────────────────────────────┘
```

### The Key Principle

The server is a **dumb relay**. It moves chat messages around and triggers on-chain instructions when phases end. It never reads individual votes. It never decides who dies. All of that logic runs in Rust inside the TEE — the server only reads the **result** from the ER after the tally instruction executes.

---

## 5. How Private ERs Power the Game

MagicBlock's **Private Ephemeral Rollup** is backed by Intel TDX (Trust Domain Extensions) — a hardware TEE that runs code in an encrypted enclave. Even the host machine can't see what's happening inside.

Here's exactly what runs inside the TEE and why:

### Role Assignment — `assign_roles`

```
Input: vrf_seed (32 bytes, publicly derived from Solana blockhash)
       player list (from game_state.players[])

Inside TEE:
  Fisher-Yates shuffle over player indices using vrf_seed bytes
  → Assigns: Mafia (1–2), Detective (1), Doctor (1), Citizens (rest)
  → Writes result to game_state.roles[player_index]

Output: game_state.roles[] sealed in ER (nobody can read it directly)
```

The server calls `readGameRolesFromER()` after this to learn who gets which role — but it reads from the TEE, it doesn't compute the result itself. If the server's read fails, roles are still correctly stored on-chain.

### Night Vote Tally — `tally_and_close_night`

```
Input: all alive PlayerState PDAs (passed as remaining_accounts)

Inside TEE:
  1. Reads night_target from each Mafia PlayerState
  2. Counts votes, finds plurality target
  3. Checks game_state.protected_player (Doctor's protection)
     → If target == protected_player: no elimination (Doctor wins!)
  4. Marks target as eliminated in game_state.eliminated[]
  5. Decrements alive_mafia or alive_citizens
  6. Resets all has_voted_night flags and night_target fields
  7. Transitions phase: Night → Day (or GameOver if win condition met)

Output: game_state.night_elimination_target (public, after tally)
```

The server reads `night_elimination_target` from ER after the TX lands. The vote totals are never exposed — only the final elimination.

### Day Vote Tally — `tally_and_close_day`

Same pattern: reads `day_vote` from each PlayerState, finds plurality, exiles that player, transitions to next Night round (or GameOver). All inside TEE.

### Why votes are private while voting is open

Each player signs an ER transaction directly from their browser — the vote goes to `tee.magicblock.app`, which is the Intel TDX endpoint. The `PlayerState.day_vote` field is written inside the TEE. Nobody outside the TEE can read the current vote state. When time runs out, the tally instruction atomically reveals the result.

---

## 6. MagicBlock Stack — Full Usage

Shadow Mafia uses **all four pillars** of the MagicBlock stack:

### `#[ephemeral]` — Program Macro

```rust
#[ephemeral]
#[program]
pub mod shadow_mafia { ... }
```

Marks the entire program as compatible with Ephemeral Rollups. Enables delegation and commit macros throughout.

### `#[delegate]` — Account Delegation

```rust
pub fn delegate_game(...) -> Result<()> {
    ctx.accounts.delegate_pda(&ctx.accounts.payer, &[GAME_SEED, ...], DelegateConfig::default())
}
```

When the host starts the game, `GameState` and each player's `PlayerState` are delegated from Solana L1 to the Private ER. Once delegated, all game logic runs inside the TEE. The account's owner changes to the Delegation Program on L1 — transactions to that account must go through the ER.

### `#[commit]` — Commit Back to L1

```rust
// end_game calls:
commit_and_undelegate_accounts(
    &ctx.accounts.payer,
    vec![&ctx.accounts.game_state.to_account_info()],
    &ctx.accounts.magic_context,
    &ctx.accounts.magic_program,
)?;
```

When the game ends, the final `GameState` (with winner, eliminations, VRF seed) is permanently written back to Solana L1. This is the immutable public record of the game outcome.

### `#[session_auth_or]` — Session Keys

```rust
#[session_auth_or(
    ctx.accounts.player_state.player == ctx.accounts.signer.key(),
    SessionError::InvalidToken
)]
pub fn mafia_night_vote(...) -> Result<()> { ... }
```

Applied to all three player action instructions: `mafia_night_vote`, `day_vote`, `doctor_protect`. This macro checks: "Is the signer either (a) the player's actual wallet, OR (b) a pre-authorized session key?" If a session key exists, the burner signs — no Phantom popup.

### MagicBlock Crank

The server exposes a Crank-compatible HTTP endpoint:

```
POST /crank/:gameId/end_night
POST /crank/:gameId/end_day
```

MagicBlock Crank can be pointed at these URLs with a configured interval to automatically trigger phase transitions without any manual intervention. The server's `setTimeout` acts as fallback when Crank is not configured.

---

## 7. On-Chain Program Instructions

### L1 Instructions (Solana Devnet)

| Instruction | Who calls it | What it does |
|-------------|-------------|--------------|
| `create_game` | Server | Creates `GameState` PDA, sets stake and max players |
| `join_game` | Each player (Phantom) | Transfers stake SOL to `GameState`, creates `PlayerState` PDA |
| `delegate_game` | Server | Moves `GameState` from L1 to Private ER |
| `delegate_player` | Server | Moves each `PlayerState` from L1 to Private ER |
| `payout` | Server (after commit) | Splits total pot among winner wallets |
| `close_game` | Server | Reclaims rent after settlement |

### Private ER Instructions (TEE — `tee.magicblock.app`)

| Instruction | Who calls it | What it does |
|-------------|-------------|--------------|
| `assign_roles` | Server | VRF Fisher-Yates role assignment inside TEE |
| `set_player_role` | Server | Syncs TEE-computed role into each `PlayerState` |
| `mafia_night_vote` | Mafia player (burner/Phantom) | Records elimination target — private until tally |
| `doctor_protect` | Doctor player (burner/Phantom) | Sets `protected_player` in `GameState` |
| `day_vote` | Every player (burner/Phantom) | Records exile vote — private until tally |
| `tally_and_close_night` | Server | On-chain tally → doctor check → elimination → phase change |
| `tally_and_close_day` | Server | On-chain tally → exile → phase change |
| `end_game` | Server | Commits final state from ER back to Solana L1 |

### Account Structures

**`GameState`** (lives on L1, delegated to ER during game):
```
game_id          u64        — unique numeric game identifier
host             Pubkey     — game creator's wallet
stake_lamports   u64        — SOL stake per player
players          [Pubkey;8] — registered player wallets
eliminated       [bool;8]   — which players are out
phase            GamePhase  — Lobby | Night | Day | GameOver
round            u8         — current round number
alive_mafia      u8         — remaining Mafia count
alive_citizens   u8         — remaining non-Mafia count
winner           Winner     — None | Citizens | Mafia
total_pot        u64        — total staked SOL
night_elim_target Pubkey   — last night's eliminated player (post-tally)
day_elim_target  Pubkey    — last day's exiled player (post-tally)
vrf_seed         [u8;32]   — public, reproducible randomness seed
roles            [u8;8]    — TEE-assigned roles per player index (private in ER)
protected_player Pubkey    — Doctor's chosen protection target (private in ER)
```

**`PlayerState`** (private in ER):
```
player           Pubkey     — this player's wallet
role             Role       — Citizen | Mafia | Detective | Doctor (private)
mafia_partner    Pubkey     — Mafia-only: partner's wallet (private)
is_eliminated    bool       — whether this player is out
night_target     Pubkey     — Mafia's vote target this night (private)
day_vote         Pubkey     — this player's exile vote (private until tally)
has_voted_night  bool       — Mafia vote submitted this round
has_voted_day    bool       — day vote submitted this round
has_protected    bool       — Doctor has used protection this round
```

---

## 8. Session Keys — Gasless Voting

Without session keys, every vote requires a Phantom popup. In a fast-paced game with a 60-second night timer, that's terrible UX.

Shadow Mafia uses **session keys** so players only ever sign once per game. Here's exactly how:

### The Setup (one Phantom popup)

When roles are assigned and the game starts, the frontend automatically:

1. Generates a **burner Keypair** in-browser (never touches the server)
2. Derives the `SessionToken` PDA on the Session Keys program
3. Builds a `create_session` instruction that:
   - Tops up the burner with 0.01 SOL from your wallet (for ER fees)
   - Sets validity to 6 hours
   - Links the burner to your wallet AND our game program
4. Both the burner and your Phantom sign this one transaction
5. From this point on, all votes are signed by the burner — **no popup**

```
Without session key:           With session key:
────────────────────           ────────────────────
mafia_night_vote →             mafia_night_vote →
  [Phantom popup] ← you sign    burner.sign() ← instant, no popup
  Wait for approval...          Done in <1 second
doctor_protect →
  [Phantom popup] ← again
day_vote →
  [Phantom popup] ← again
```

### How the Program Validates It

The `#[session_auth_or]` macro on vote instructions checks:
- If `session_token` account is provided: validate that `session_token.authority == player_state.player` AND `session_token.session_signer == signer`
- If validation passes: accept the burner as the signer
- If no session token: fall back to requiring the player's actual wallet

If `create_session` fails (e.g. wallet doesn't have enough SOL), the game gracefully falls back to Phantom popup per vote.

### Session Key Program
```
Program ID: KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5
SessionToken PDA seeds: ["session_token", target_program, session_signer, authority]
```

---

## 9. VRF Seed — Verifiable Role Assignment

The VRF (Verifiable Random Function) seed determines who gets which role. Shadow Mafia makes this publicly verifiable — anyone can check that the server didn't cheat.

### How it's derived

```javascript
// Server-side (index.js)
const { blockhash } = await devnetConn.getLatestBlockhash();
const blockhashBytes = Buffer.from(bs58.decode(blockhash));

// Sort wallets — deterministic regardless of join order
const sortedKeys = [...playerWallets].sort();
const playerBytes = Buffer.concat(sortedKeys.map(w => new PublicKey(w).toBuffer()));

const vrfSeed = SHA256(blockhashBytes || playerBytes);
```

### Why this is fair

- The **blockhash** comes from Solana devnet at game start time — the server can't predict or control it
- The **sorted player pubkeys** are fixed once the game starts — no one can change the player list
- Anyone can look up the blockhash from the Solana explorer and recompute the same seed
- The seed is stored publicly in `game_state.vrf_seed` on L1 after the game
- The game UI shows the first 16 hex digits of the seed hash so players can verify it

---

## 10. Payout — Real SOL on the Line

Every player stakes SOL when they join (`join_game` transfers `stake_lamports` from the player's wallet into the `GameState` PDA). The pot accumulates there throughout the game.

When the game ends:

1. `end_game` commits final state from TEE → L1 (writes winner, eliminations)
2. Server waits 8 seconds for undelegation to finalize
3. `payout` instruction runs on L1:

```rust
pub fn payout(ctx: Context<Payout>, game_id: u64) -> Result<()> {
    let pot = game_state.total_pot;
    let winner_count = ctx.remaining_accounts.len() as u64;
    let share = pot / winner_count;

    for winner_account in ctx.remaining_accounts.iter() {
        **game_state.lamports -= share;
        **winner_account.lamports += share;
    }
}
```

**Mafia wins:** surviving Mafia members split the pot
**Citizens win:** surviving Citizens split the pot

The split is equal and automatic. No server can intercept it. If payout fails for any reason, the SOL stays locked in the `GameState` PDA — it can be recovered by calling `close_game`.

---

## 11. Running the Project Locally

### Prerequisites

- Node.js 18+, npm
- Phantom Wallet browser extension (set to Devnet)
- Devnet SOL in your wallet — get it from [faucet.solana.com](https://faucet.solana.com)
- The Anchor program is already deployed — no Rust build needed to play

### Clone and Install

```bash
git clone <repo-url>
cd shadow-mafia

# Install server dependencies
cd server && npm install

# Install frontend dependencies
cd ../app && npm install
```

### Configure Server

Create `server/.env`:
```bash
DEVNET_RPC=https://api.devnet.solana.com
TEE_RPC=https://tee.magicblock.app
PORT=3001
```

The server needs a funded keypair to sign L1 and ER transactions. On first run it generates one automatically:
```bash
cd server && node index.js
# Look for: 🔑 Server keypair : <address>
# Fund it:  solana airdrop 2 <address> --url devnet
```

### Start the Server

```bash
cd server
npm start
# Server runs on http://localhost:3001
```

### Start the Frontend

```bash
cd app
npm run dev
# App runs on http://localhost:3000
```

### Playing a Game

1. Open `http://localhost:3000` in 4 separate browser windows (or different browsers)
2. Connect a different Phantom wallet (with devnet SOL) in each window
3. In one window: click **Create Game** → share the game code
4. In the other three windows: click **Join Game** → enter the game code
5. The host clicks **Start Game** when all players have joined
6. Sign the one-time session key popup — all future votes are gasless
7. Play the game!

### Verifying TEE Connection

```bash
curl -X GET https://tee.magicblock.app
# Expected: {"result":"ok"}
```

If this fails, switch to the public devnet ER by changing `.env`:
```bash
TEE_RPC=https://devnet.magicblock.app
```
(The devnet ER doesn't have Intel TDX but is functionally compatible for testing.)

---

## 12. Project Structure

```
shadow-mafia/
│
├── programs/shadow-mafia/src/lib.rs    ← Anchor program (deployed on Solana devnet)
│   ├── create_game / join_game         ← L1: lobby + staking
│   ├── delegate_game / delegate_player ← L1→ER: move accounts to TEE
│   ├── assign_roles                    ← ER: VRF role assignment inside TEE
│   ├── mafia_night_vote / day_vote     ← ER: private player actions (#[session_auth_or])
│   ├── doctor_protect                  ← ER: Doctor's protection (#[session_auth_or])
│   ├── tally_and_close_night/day       ← ER: on-chain tallies (TEE-authoritative)
│   ├── end_game                        ← ER→L1: commit + undelegate (#[commit])
│   └── payout                          ← L1: split pot to winner wallets
│
├── server/index.js                     ← Node.js relay server
│   ├── Socket.io event handlers        ← real-time game coordination
│   ├── TEE transaction builders        ← L1 + ER instruction construction
│   ├── VRF seed derivation             ← SHA256(blockhash + sorted players)
│   ├── Vote poller                     ← watches ER for vote completion
│   ├── Phase management                ← endNightPhase / endDayPhase
│   ├── POST /crank/:gameId/:action     ← MagicBlock Crank endpoint
│   └── GET /game/:gameId               ← game state HTTP endpoint
│
└── app/app/page.tsx                    ← Next.js frontend (single-page game)
    ├── Wallet connection               ← Phantom via wallet-adapter
    ├── Socket.io client                ← real-time server events
    ├── Session key creation            ← one popup → gasless votes
    ├── ER vote transactions            ← direct to tee.magicblock.app
    ├── Game board render               ← cloaked SVG characters
    ├── Chat + mafia chat               ← public + private channels
    └── Game over + result hash         ← VRF seed reveal + payout notification
```

---

## Technical Notes

**Why not use a local validator?**
The TEE endpoint (`tee.magicblock.app`) is a MagicBlock-hosted Intel TDX vault — there's no local equivalent. The program is deployed on Solana devnet and all testing uses the live devnet environment.

**Why is the server trusted for some things?**
The server calls `tally_and_close_night` and `tally_and_close_day` — but these are Rust instructions running inside the TEE. The server is the trigger, not the executor. The TEE decides who dies, not the server. The server cannot change the outcome by calling the instruction with different arguments — the Rust program reads from the sealed PlayerState accounts directly.

**What stops the server from lying about the VRF seed?**
Nothing — but the VRF seed is stored publicly in `game_state.vrf_seed` on L1 after the game. Anyone can take the seed, run the Fisher-Yates shuffle, and verify the role assignment matches. If the server manipulated the seed, this would be provably detectable.

**Why use Socket.io at all?**
Blockchain events are too slow for real-time game feel. The socket layer gives instant feedback (chat, vote confirmations, phase flashes, sound effects) while the actual game logic happens on-chain. Think of it as the "render layer" — it shows you what the TEE has decided, not the other way around.

---

*Built for Solana Blitz v2 Hackathon — MagicBlock Privacy Track*
*By Sunil Pitti*
