/**
 * Shadow Mafia — TEE-Backed Game Server
 *
 * Full TEE alignment (Intel TDX Private Ephemeral Rollup):
 * - Every game is anchored on Solana devnet (GameState PDA) and delegated to ER
 * - assign_roles: VRF seed → Fisher-Yates role assignment INSIDE TEE (game_state.roles[])
 *   Server READS the on-chain role assignment — it never decides who gets which role.
 * - Night votes: each Mafia player signs their own ER transaction (mafia_night_vote)
 *   tally_and_close_night: reads all votes, tallies, eliminates — ENTIRELY on-chain in TEE.
 *   Server calls tally instruction; TEE decides the outcome. Server reads result from ER.
 * - Day votes: each player signs their own ER transaction (day_vote)
 *   tally_and_close_day: same on-chain tally pattern for day phase.
 * - Game end: final state COMMITTED from TEE to L1 (end_game + #[commit])
 * - Socket server is a real-time rendering layer; TEE is the authoritative game engine.
 */

require("dotenv").config();
const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const cors   = require("cors");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

// ── Solana imports ────────────────────────────────────────────────────────
const {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram,
} = require("@solana/web3.js");

// ─────────────────────────────────────────────────────────────────────────
// SERVER KEYPAIR  (TEE Coordinator — signs all on-chain/TEE transactions)
// ─────────────────────────────────────────────────────────────────────────
// Supports two sources (in priority order):
//   1. SERVER_PRIVATE_KEY env var — JSON array string, e.g. "[1,2,3,...]"
//      Set this on Railway/Render/Vercel for cloud deployment.
//   2. server-keypair.json file — used for local development.
const KEYPAIR_PATH = path.join(__dirname, "server-keypair.json");
let serverKeypair;
if (process.env.SERVER_PRIVATE_KEY) {
  serverKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.SERVER_PRIVATE_KEY))
  );
  console.log("🔑 Loaded keypair from SERVER_PRIVATE_KEY env var.");
} else if (fs.existsSync(KEYPAIR_PATH)) {
  serverKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8")))
  );
} else {
  serverKeypair = Keypair.generate();
  fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(Array.from(serverKeypair.secretKey)));
  console.log("🔑 Generated new server keypair (fund it with devnet SOL).");
}
console.log(`🔑 Server keypair : ${serverKeypair.publicKey.toBase58()}`);
console.log(`   Fund command   : solana airdrop 2 ${serverKeypair.publicKey.toBase58()} --url devnet`);

// ─────────────────────────────────────────────────────────────────────────
// CONNECTIONS
// ─────────────────────────────────────────────────────────────────────────
const DEVNET_RPC = process.env.DEVNET_RPC || "https://api.devnet.solana.com";
const TEE_RPC    = process.env.TEE_RPC    || "https://tee.magicblock.app";
const devnetConn = new Connection(DEVNET_RPC, { commitment: "confirmed" });
const teeConn    = new Connection(TEE_RPC,    { commitment: "confirmed" });

// ─────────────────────────────────────────────────────────────────────────
// PROGRAM CONSTANTS
// ─────────────────────────────────────────────────────────────────────────
const PROGRAM_ID         = new PublicKey("4jEx2Z526KdKe97TKqf7kZnkdM3LBDtH6Et5n2cJnam8");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM      = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT      = new PublicKey("MagicContext1111111111111111111111111111111");
const NULL_KEY           = new PublicKey("11111111111111111111111111111111"); // Pubkey::default()

const GAME_SEED_B   = Buffer.from("shadow_mafia_game");
const PLAYER_SEED_B = Buffer.from("shadow_mafia_player");

function anchorDisc(name) {
  return Buffer.from(
    require("crypto").createHash("sha256").update(`global:${name}`).digest()
  ).slice(0, 8);
}

// Instruction discriminators (SHA-256("global:<name>")[0:8])
const DISC = {
  createGame:          Buffer.from([124, 69, 75, 66, 184, 220, 72, 206]),
  joinGame:            Buffer.from([107, 112, 18, 38, 56, 173, 60, 128]),
  delegateGame:        Buffer.from([116, 183, 70, 107, 112, 223, 122, 210]),
  assignRoles:         Buffer.from([55, 227, 97, 221, 175, 205, 197, 179]),
  endGame:             Buffer.from([224, 135, 245, 99, 67, 175, 121, 252]),
  delegatePlayer:      anchorDisc("delegate_player"),
  setPlayerRole:       anchorDisc("set_player_role"),
  mafiaVote:           anchorDisc("mafia_night_vote"),
  dayVote:             anchorDisc("day_vote"),
  // New: on-chain vote tally — TEE decides outcome, server never reads intermediate votes
  tallyCloseNight:     anchorDisc("tally_and_close_night"),
  tallyCloseDay:       anchorDisc("tally_and_close_day"),
  // On-chain payout + doctor protection
  payout:              anchorDisc("payout"),
  doctorProtect:       anchorDisc("doctor_protect"),
};

// ─────────────────────────────────────────────────────────────────────────
// PDA HELPERS
// ─────────────────────────────────────────────────────────────────────────
function numBuf(id) {
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64LE(BigInt(id), 0);
  return b;
}
function deriveGamePDA(numId) {
  return PublicKey.findProgramAddressSync([GAME_SEED_B, numBuf(numId)], PROGRAM_ID)[0];
}
function derivePlayerPDA(numId, playerKey) {
  return PublicKey.findProgramAddressSync(
    [PLAYER_SEED_B, numBuf(numId), new PublicKey(playerKey).toBuffer()], PROGRAM_ID
  )[0];
}
// Buffer PDA seeds: ["buffer", pda.toBytes()] under PROGRAM_ID (owner program)
function deriveBufferPDA(gamePDA) {
  return PublicKey.findProgramAddressSync([Buffer.from("buffer"), gamePDA.toBuffer()], PROGRAM_ID)[0];
}
// Delegation record seeds: ["delegation", pda.toBytes()] under DELEGATION_PROGRAM
function deriveRecordPDA(gamePDA) {
  return PublicKey.findProgramAddressSync([Buffer.from("delegation"), gamePDA.toBuffer()], DELEGATION_PROGRAM)[0];
}
// Delegation metadata seeds: ["delegation-metadata", pda.toBytes()] under DELEGATION_PROGRAM
function deriveMetaPDA(gamePDA) {
  return PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), gamePDA.toBuffer()], DELEGATION_PROGRAM)[0];
}

// ─────────────────────────────────────────────────────────────────────────
// TRANSACTION HELPERS
// ─────────────────────────────────────────────────────────────────────────
async function sendL1Tx(ixs, extraSigners = []) {
  const { blockhash, lastValidBlockHeight } = await devnetConn.getLatestBlockhash();
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = serverKeypair.publicKey;
  tx.sign(serverKeypair, ...extraSigners);
  try {
    const sig = await devnetConn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await devnetConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return sig;
  } catch (e) {
    const logs = e?.logs || e?.transactionLogs || [];
    if (logs.length) console.error("[L1 TX LOGS]", logs.join("\n"));
    throw new Error(e?.message || JSON.stringify(e));
  }
}

async function sendTeeTx(ixs) {
  const { blockhash, lastValidBlockHeight } = await teeConn.getLatestBlockhash();
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = serverKeypair.publicKey;
  tx.sign(serverKeypair);
  const sig = await teeConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await teeConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

// ─────────────────────────────────────────────────────────────────────────
// TEE GAME OPERATIONS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Step 1 (L1): Create GameState PDA + add 4 dummy players.
 * The Anchor program requires player_count >= 4 for assign_roles.
 * Dummy keypairs are funded by server, then each signs their join_game.
 */
async function setupGameOnChain(numId, maxPlayers) {
  const gameIdBytes = numBuf(numId);
  const gamePDA = deriveGamePDA(numId);

  // create_game: [disc 8B][game_id 8B][stake 8B][max_players 1B]
  const createData = Buffer.alloc(25);
  DISC.createGame.copy(createData, 0);
  createData.writeBigUInt64LE(BigInt(numId), 8);
  createData.writeBigUInt64LE(1000n, 16);           // stake = 1000 lamports (minimum)
  createData.writeUInt8(maxPlayers || 6, 24);

  return sendL1Tx([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: gamePDA,                 isSigner: false, isWritable: true  },
      { pubkey: serverKeypair.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: createData,
  })]);
}

/**
 * Step 2 (L1): Delegate GameState PDA to Private ER (TEE vault).
 * After this, the account owner changes to DELEGATION_PROGRAM.
 * Account order from ephemeral-rollups-sdk IDL analysis:
 *   payer → buffer_pda → delegation_record → delegation_metadata → pda → owner_program → delegation_program → system_program
 */
async function delegateGameTEE(numId) {
  const gamePDA = deriveGamePDA(numId);
  const bufPDA  = deriveBufferPDA(gamePDA);
  const recPDA  = deriveRecordPDA(gamePDA);
  const metPDA  = deriveMetaPDA(gamePDA);

  const data = Buffer.alloc(16);
  DISC.delegateGame.copy(data, 0);
  data.writeBigUInt64LE(BigInt(numId), 8);

  return sendL1Tx([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: serverKeypair.publicKey, isSigner: true,  isWritable: true  }, // payer
      { pubkey: bufPDA,                  isSigner: false, isWritable: true  }, // buffer_pda
      { pubkey: recPDA,                  isSigner: false, isWritable: true  }, // delegation_record
      { pubkey: metPDA,                  isSigner: false, isWritable: true  }, // delegation_metadata
      { pubkey: gamePDA,                 isSigner: false, isWritable: true  }, // pda (GameState)
      { pubkey: PROGRAM_ID,              isSigner: false, isWritable: false }, // owner_program
      { pubkey: DELEGATION_PROGRAM,      isSigner: false, isWritable: false }, // delegation_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ],
    data,
  })]);
}

async function delegatePlayerTEE(numId, playerWallet) {
  const playerKey = new PublicKey(playerWallet);
  const playerPDA = derivePlayerPDA(numId, playerWallet);
  const bufPDA    = PublicKey.findProgramAddressSync([Buffer.from("buffer"), playerPDA.toBuffer()], PROGRAM_ID)[0];
  const recPDA    = PublicKey.findProgramAddressSync([Buffer.from("delegation"), playerPDA.toBuffer()], DELEGATION_PROGRAM)[0];
  const metPDA    = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), playerPDA.toBuffer()], DELEGATION_PROGRAM)[0];

  const data = Buffer.alloc(48);
  DISC.delegatePlayer.copy(data, 0);
  data.writeBigUInt64LE(BigInt(numId), 8);
  playerKey.toBuffer().copy(data, 16);

  return sendL1Tx([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: serverKeypair.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: bufPDA,                  isSigner: false, isWritable: true  },
      { pubkey: recPDA,                  isSigner: false, isWritable: true  },
      { pubkey: metPDA,                  isSigner: false, isWritable: true  },
      { pubkey: playerPDA,               isSigner: false, isWritable: true  },
      { pubkey: PROGRAM_ID,              isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM,      isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })]);
}

/**
 * Step 3 (TEE): assign_roles — VRF seed → Fisher-Yates inside TEE.
 * The Rust program now computes the actual per-player role assignments using the VRF seed.
 * game_state.roles[i] is written by the TEE; server reads it back (not computes it).
 */
async function teeAssignRoles(numId, vrfSeedBytes) {
  const gamePDA = deriveGamePDA(numId);

  // assign_roles: [disc 8B][game_id 8B][vrf_seed 32B]
  const assignData = Buffer.alloc(48);
  DISC.assignRoles.copy(assignData, 0);
  assignData.writeBigUInt64LE(BigInt(numId), 8);
  Buffer.from(vrfSeedBytes).copy(assignData, 16);

  return sendTeeTx([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: gamePDA,                 isSigner: false, isWritable: true },
      { pubkey: serverKeypair.publicKey, isSigner: true,  isWritable: true },
    ],
    data: assignData,
  })]);
}

/**
 * Read game_state.roles[] from ER after assign_roles.
 * Returns { walletAddress → 'Mafia'|'Citizen'|'Detective' } for real players stored on-chain.
 * This is the authoritative role assignment — decided by the TEE, not server JS.
 *
 * GameState layout offsets:
 *   [0-7]   discriminator
 *   [8-15]  game_id (u64 LE)
 *   [16-47] host (Pubkey)
 *   [48-55] stake_lamports (u64 LE)
 *   [56]    max_players (u8)
 *   [57]    player_count (u8)
 *   [58-313] players [Pubkey; 8] (8×32 bytes)
 *   [314-321] eliminated [bool; 8]
 *   [322]   phase (u8)
 *   [323]   round (u8)
 *   [324-327] current_tick (u32 LE)
 *   [328]   alive_mafia (u8)
 *   [329]   alive_citizens (u8)
 *   [330]   winner (u8)
 *   [331-338] total_pot (u64 LE)
 *   [339-370] night_elimination_target (Pubkey)
 *   [371-402] day_elimination_target (Pubkey)
 *   [403-434] vrf_seed [u8; 32]
 *   [435-442] created_at (i64 LE)
 *   [443-450] settled_at (i64 LE)
 *   [451-458] roles [u8; 8]  ← TEE-assigned role per player index
 */
async function readGameRolesFromER(numId) {
  try {
    const gamePDA = deriveGamePDA(numId);
    const acct = await teeConn.getAccountInfo(gamePDA);
    if (!acct || acct.data.length < 459) return null;
    const d = acct.data;
    const playerCount = d[57];
    const ROLE_NAMES = ['Citizen', 'Mafia', 'Detective', 'Doctor'];
    const roleMap = {};
    for (let i = 0; i < playerCount; i++) {
      const start = 58 + i * 32;
      const pubkeyBytes = d.slice(start, start + 32);
      const wallet = new PublicKey(pubkeyBytes).toBase58();
      roleMap[wallet] = ROLE_NAMES[d[451 + i]] || 'Citizen';
    }
    return roleMap; // { walletBase58 → 'Citizen'|'Mafia'|'Detective' }
  } catch (e) {
    console.warn('[TEE] readGameRolesFromER failed:', e.message);
    return null;
  }
}

async function teeSetPlayerRoles(numId, playerRoleMap) {
  const roleToU8 = { Citizen: 0, Mafia: 1, Detective: 2, Doctor: 3 };
  const NULL_KEY = new PublicKey("11111111111111111111111111111111");
  const gamePDA  = deriveGamePDA(numId);

  for (const [walletAddr, role] of Object.entries(playerRoleMap)) {
    try {
      const playerKey = new PublicKey(walletAddr);
      const playerPDA = derivePlayerPDA(numId, walletAddr);
      const roleU8    = roleToU8[role] ?? 0;

      let mafiaPartner = NULL_KEY;
      if (role === "Mafia") {
        const partner = Object.entries(playerRoleMap).find(([w, r]) => r === "Mafia" && w !== walletAddr);
        if (partner) mafiaPartner = new PublicKey(partner[0]);
      }

      const data = Buffer.alloc(81);
      DISC.setPlayerRole.copy(data, 0);
      data.writeBigUInt64LE(BigInt(numId), 8);
      playerKey.toBuffer().copy(data, 16);
      data.writeUInt8(roleU8, 48);
      mafiaPartner.toBuffer().copy(data, 49);

      await sendTeeTx([new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: gamePDA,                 isSigner: false, isWritable: false },
          { pubkey: playerPDA,               isSigner: false, isWritable: true  },
          { pubkey: serverKeypair.publicKey, isSigner: true,  isWritable: true  },
        ],
        data,
      })]);
      console.log(`[TEE ✓] set_player_role ${walletAddr.slice(0,8)}... → ${role}`);
    } catch (e) {
      console.error(`[TEE ✗] set_player_role ${walletAddr.slice(0,8)}...:`, e?.message?.slice(0, 120));
    }
  }
}

async function readPlayerStateFromER(numId, walletAddr) {
  try {
    const playerPDA = derivePlayerPDA(numId, walletAddr);
    const acct = await teeConn.getAccountInfo(playerPDA);
    if (!acct || acct.data.length < 149) return null;
    const d = acct.data;
    return {
      role:          d[49],
      isEliminated:  d[82] === 1,
      nightTarget:   new PublicKey(d.slice(83, 115)).toBase58(),
      dayVote:       new PublicKey(d.slice(115, 147)).toBase58(),
      hasVotedNight: d[147] === 1,
      hasVotedDay:   d[148] === 1,
      hasProtected:  d.length >= 150 ? d[149] === 1 : false,
    };
  } catch { return null; }
}

async function readGameStateFromER(numId) {
  try {
    const gamePDA = deriveGamePDA(numId);
    const acct    = await teeConn.getAccountInfo(gamePDA);
    if (!acct || acct.data.length < 340) return null;
    const d = acct.data;
    const nullB58 = NULL_KEY.toBase58();
    let nightEliminationTarget = null;
    let dayEliminationTarget   = null;
    if (d.length >= 371) {
      const t = new PublicKey(d.slice(339, 371)).toBase58();
      if (t !== nullB58) nightEliminationTarget = t;
    }
    if (d.length >= 403) {
      const t = new PublicKey(d.slice(371, 403)).toBase58();
      if (t !== nullB58) dayEliminationTarget = t;
    }
    return { phase: d[322], round: d[323], aliveMafia: d[328], aliveCitizens: d[329], winner: d[330],
             nightEliminationTarget, dayEliminationTarget };
  } catch { return null; }
}

function startVotePoller(gameId) {
  const game = games[gameId];
  if (!game || !game.teeEnabled || !game.numericId) return;
  if (game.votePoller) { clearInterval(game.votePoller); game.votePoller = null; }

  game.votePoller = setInterval(async () => {
    const g = games[gameId];
    if (!g || (g.phase !== "Night" && g.phase !== "Day")) {
      clearInterval(game.votePoller); game.votePoller = null; return;
    }
    try {
      const NULL_B58 = "11111111111111111111111111111111";
      const aliveWallets = Object.keys(g.players).filter(w => !g.players[w].isEliminated);
      if (aliveWallets.length === 0) return;

      const states = await Promise.all(aliveWallets.map(w => readPlayerStateFromER(g.numericId, w)));

      for (let i = 0; i < aliveWallets.length; i++) {
        const st = states[i];
        const p  = g.players[aliveWallets[i]];
        if (!st || !p) continue;
        if (g.phase === "Night") {
          p.hasVotedNight = st.hasVotedNight;
          if (st.hasVotedNight && st.nightTarget !== NULL_B58) p.nightVote = st.nightTarget;
        } else if (g.phase === "Day") {
          p.hasVotedDay = st.hasVotedDay;
          if (st.hasVotedDay && st.dayVote !== NULL_B58) p.dayVoteTarget = st.dayVote;
        }
      }

      if (g.phase === "Night") {
        const mafiaPlayers = Object.values(g.players).filter(p => p.role === "Mafia" && !p.isEliminated);
        if (mafiaPlayers.length > 0 && mafiaPlayers.every(p => p.hasVotedNight)) {
          clearInterval(game.votePoller); game.votePoller = null;
          console.log(`[VotePoller] All mafia voted on ER → ending night for ${gameId}`);
          endNightPhase(gameId);
        }
      } else if (g.phase === "Day") {
        const alive  = Object.values(g.players).filter(p => !p.isEliminated);
        const voted  = alive.filter(p => p.hasVotedDay);
        if (voted.length >= alive.length && alive.length > 0) {
          clearInterval(game.votePoller); game.votePoller = null;
          console.log(`[VotePoller] All players voted on ER → ending day for ${gameId}`);
          endDayPhase(gameId);
        }
      }
    } catch (e) {
      console.error(`[VotePoller] ${gameId}:`, e.message);
    }
  }, 2500);
}

/**
 * tally_and_close_night (TEE) — FULLY ON-CHAIN VOTE TALLY.
 *
 * Passes all alive PlayerState PDAs as remaining_accounts (writable).
 * The TEE Rust program:
 *   1. Reads night_target from each Mafia PlayerState (no server involvement)
 *   2. Tallies votes entirely on-chain via Fisher-Yates-selected role indices
 *   3. Eliminates the plurality target in game_state.eliminated[]
 *   4. Updates alive_mafia/alive_citizens from game_state.roles[] (TEE-only)
 *   5. Resets vote flags + marks eliminated player in PlayerState
 *   6. Transitions phase to Day or GameOver
 *
 * Server never reads intermediate vote state — outcome comes from this TX.
 * For demo-only games (no real PDAs): passes empty remaining_accounts.
 *   TEE finds 0 votes → no elimination → ER cycles phases (acceptable for demo).
 */
async function teeTallyCloseNight(numId, aliveWallets) {
  const gamePDA = deriveGamePDA(numId);
  const data = Buffer.alloc(16);
  DISC.tallyCloseNight.copy(data, 0);
  data.writeBigUInt64LE(BigInt(numId), 8);

  // Pass all alive player PDAs as remaining_accounts (writable) so TEE can
  // read their votes and write back vote flags + elimination status.
  const remainingKeys = aliveWallets.map(w => ({
    pubkey: derivePlayerPDA(numId, w),
    isSigner: false,
    isWritable: true,
  }));

  return sendTeeTx([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: gamePDA,                 isSigner: false, isWritable: true },
      { pubkey: serverKeypair.publicKey, isSigner: true,  isWritable: true },
      ...remainingKeys,
    ],
    data,
  })]);
}

/**
 * tally_and_close_day (TEE) — FULLY ON-CHAIN DAY VOTE TALLY.
 * Same pattern as teeTallyCloseNight but for the day phase.
 */
async function teeTallyCloseDay(numId, aliveWallets) {
  const gamePDA = deriveGamePDA(numId);
  const data = Buffer.alloc(16);
  DISC.tallyCloseDay.copy(data, 0);
  data.writeBigUInt64LE(BigInt(numId), 8);

  const remainingKeys = aliveWallets.map(w => ({
    pubkey: derivePlayerPDA(numId, w),
    isSigner: false,
    isWritable: true,
  }));

  return sendTeeTx([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: gamePDA,                 isSigner: false, isWritable: true },
      { pubkey: serverKeypair.publicKey, isSigner: true,  isWritable: true },
      ...remainingKeys,
    ],
    data,
  })]);
}

/**
 * Commit (TEE → L1): end_game calls commit_and_undelegate_accounts.
 * Final game state is written back to Solana devnet permanently.
 */
async function teeCommitGame(numId) {
  const gamePDA = deriveGamePDA(numId);

  const data = Buffer.alloc(16);
  DISC.endGame.copy(data, 0);
  data.writeBigUInt64LE(BigInt(numId), 8);

  return sendTeeTx([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: gamePDA,                 isSigner: false, isWritable: true  }, // game_state
      { pubkey: serverKeypair.publicKey, isSigner: true,  isWritable: true  }, // payer
      { pubkey: MAGIC_PROGRAM,           isSigner: false, isWritable: false }, // magic_program
      { pubkey: MAGIC_CONTEXT,           isSigner: false, isWritable: true  }, // magic_context
    ],
    data,
  })]);
}

/**
 * L1: Distribute pot to winners. Called after end_game commits + undelegation settles.
 * remaining_accounts = winner wallet PublicKeys (writable, unsigned).
 */
async function payoutGame(numId, winnerWallets) {
  const gamePDA = deriveGamePDA(numId);
  const data = Buffer.alloc(16);
  DISC.payout.copy(data, 0);
  data.writeBigUInt64LE(BigInt(numId), 8);

  const remainingAccounts = winnerWallets.map(w => ({
    pubkey: new PublicKey(w), isSigner: false, isWritable: true,
  }));

  return sendL1Tx([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: gamePDA,                 isSigner: false, isWritable: true  },
      { pubkey: serverKeypair.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...remainingAccounts,
    ],
    data,
  })]);
}

/**
 * Fire-and-forget TEE call. Never throws. Emits tee_update to socket room.
 * action: string key for the UI (delegateGame, assignRoles, endNight, endDay, commitGame)
 */
function fireTEE(gameId, action, fn) {
  fn().then(sig => {
    console.log(`[TEE ✓] ${gameId} ${action}: ${sig}`);
    const game = games[gameId];
    if (game) { game.teeSigs = game.teeSigs || {}; game.teeSigs[action] = sig; }
    if (gameId) io.to(gameId).emit("tee_update", { action, txSig: sig, status: "ok" });
  }).catch(err => {
    const msg = err?.message?.slice(0, 120) || String(err);
    console.error(`[TEE ✗] ${gameId} ${action}: ${msg}`);
    if (gameId) io.to(gameId).emit("tee_update", { action, status: "failed" });
  });
}

// Check server balance on startup
(async () => {
  try {
    const bal = await devnetConn.getBalance(serverKeypair.publicKey);
    const sol = (bal / 1e9).toFixed(4);
    console.log(`💰 Server balance: ${sol} SOL`);
    if (bal < 50_000_000) {
      console.warn(`⚠️  Low balance! Airdrop: solana airdrop 2 ${serverKeypair.publicKey.toBase58()} --url devnet`);
    }
  } catch (e) { console.error("[TEE] Balance check failed:", e.message); }
})();

// ═════════════════════════════════════════════════════════════════════════
// EXPRESS + SOCKET.IO SETUP
// ═════════════════════════════════════════════════════════════════════════
const app    = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const games = {};

const NIGHT_DURATION_MS = 60_000;
const DAY_DURATION_MS   = 180_000;
const VOTE_GRACE_MS     = 5_000;

// ── Role assignment ───────────────────────────────────────────────────────
function assignRoles(players, vrfSeed) {
  const wallets = Object.keys(players);
  const n = wallets.length;
  const mafiaCount    = n >= 6 ? 2 : 1;
  const detectiveCount = n >= 8 ? 2 : 1;
  const doctorCount   = n >= 5 ? 1 : 0;

  const indices = wallets.map((_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = vrfSeed[i % 32] % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const roles = {};
  for (let i = 0; i < n; i++) {
    const w = wallets[indices[i]];
    if (i < mafiaCount)                                     roles[w] = "Mafia";
    else if (i < mafiaCount + detectiveCount)               roles[w] = "Detective";
    else if (i < mafiaCount + detectiveCount + doctorCount) roles[w] = "Doctor";
    else                                                    roles[w] = "Citizen";
  }
  return roles;
}

/**
 * VRF seed derivation — publicly verifiable, server cannot manipulate.
 * seed = SHA-256(recentBlockhash_bytes || sorted_player_pubkey_bytes)
 * Anyone can recompute this from the on-chain blockhash + player list.
 */
async function getVrfSeed(playerWallets) {
  const { blockhash } = await devnetConn.getLatestBlockhash();
  // Convert base58 blockhash to bytes via Buffer (same as on-chain)
  const blockhashBytes = Buffer.from(
    require("bs58").decode(blockhash)
  );
  // Sort wallets so seed is deterministic regardless of join order
  const sortedKeys = [...playerWallets].sort();
  const playerBytes = Buffer.concat(sortedKeys.map(w => new PublicKey(w).toBuffer()));
  const seed = crypto.createHash("sha256").update(Buffer.concat([blockhashBytes, playerBytes])).digest();
  return Array.from(seed);
}
function vrfSeedHex(seed) { return Buffer.from(seed).toString("hex").slice(0, 16) + "..."; }

function countAlive(game) {
  let aliveMafia = 0, aliveCitizens = 0;
  for (const p of Object.values(game.players)) {
    if (!p.isEliminated) {
      if (p.role === "Mafia") aliveMafia++;
      else aliveCitizens++;
    }
  }
  return { aliveMafia, aliveCitizens };
}

function checkWinCondition(game) {
  const { aliveMafia, aliveCitizens } = countAlive(game);
  if (aliveMafia === 0) return "Citizens";
  if (aliveMafia >= aliveCitizens) return "Mafia";
  return null;
}

function getMafiaPartners(game, playerWallet) {
  return Object.entries(game.players)
    .filter(([w, p]) => p.role === "Mafia" && w !== playerWallet)
    .map(([, p]) => p.username);
}

function computeResultHash(game) {
  const data = JSON.stringify({
    gameId: game.gameId, vrfSeed: game.vrfSeed,
    players: Object.entries(game.players).map(([w, p]) => ({ wallet: w, role: p.role, isEliminated: p.isEliminated })),
    winner: game.winner, round: game.round,
  });
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16) + "...";
}

function clearPhaseTimer(game) {
  if (game.phaseTimer) { clearTimeout(game.phaseTimer); game.phaseTimer = null; }
}

function getDayVoteTallies(game) {
  const tallies = {};
  for (const p of Object.values(game.players)) {
    if (!p.isEliminated && p.dayVote) tallies[p.dayVote] = (tallies[p.dayVote] || 0) + 1;
  }
  return tallies;
}

function getRoleMessage(role, wallet, game) {
  if (role === "Mafia") {
    const partners = getMafiaPartners(game, wallet);
    return `You are MAFIA 🔴. Partners: ${partners.join(", ") || "None"}. Eliminate citizens!`;
  }
  if (role === "Detective") return "You are the DETECTIVE 🔵. Each night you may investigate one player.";
  if (role === "Doctor")    return "You are the DOCTOR 💉. Each night you may protect one player from elimination.";
  return "You are a CITIZEN ⚪. Find and vote out the Mafia!";
}

// ─────────────────────────────────────────────────────────────────────────
// PHASE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────
function startNightPhase(gameId) {
  const game = games[gameId];
  if (!game) return;
  game.phase = "Night";
  game.mafiaVotes = {};

  for (const p of Object.values(game.players)) {
    p.hasVotedNight = false; p.hasVotedDay = false;
    p.nightTarget = null; p.dayVote = null; p.hasProtected = false;
  }

  io.to(gameId).emit("phase_change", { phase: "Night", round: game.round, durationMs: NIGHT_DURATION_MS });

  // Private role info per player
  for (const [wallet, p] of Object.entries(game.players)) {
    if (p.isEliminated || !p.socketId) continue;
    if (p.role === "Mafia") {
      const partners = getMafiaPartners(game, wallet);
      io.to(p.socketId).emit("your_role_private", {
        role: "Mafia", partners,
        message: `MAFIA 🔴 — Partners: ${partners.join(", ") || "None"}. Choose your target.`,
      });
    }
    if (p.role === "Detective") io.to(p.socketId).emit("your_role_private", { role: "Detective", message: "DETECTIVE 🔵 — Investigate one player tonight." });
    if (p.role === "Doctor") {
      io.to(p.socketId).emit("your_role_private", { role: "Doctor", message: "DOCTOR 💉 — Protect one player from elimination tonight." });
    }
  }

  clearPhaseTimer(game);
  game.phaseTimer = setTimeout(() => endNightPhase(gameId), NIGHT_DURATION_MS + VOTE_GRACE_MS);
  if (game.teeEnabled && game.numericId) startVotePoller(gameId);
}

async function endNightPhase(gameId) {
  const game = games[gameId];
  if (!game || game.phase !== "Night") return;
  clearPhaseTimer(game);
  if (game.votePoller) { clearInterval(game.votePoller); game.votePoller = null; }

  // Track if Mafia had votes before tally (to detect doctor saves)
  const hadMafiaVotes = Object.values(game.players).some(p =>
    p.role === "Mafia" && !p.isEliminated && p.hasVotedNight
  );

  let eliminatedWallet = null;

  if (game.teeEnabled && game.numericId) {
    // ── TEE: tally_and_close_night — AUTHORITATIVE on-chain vote tally ──
    // Pass all alive player PDAs. Rust program tallies, checks doctor protection,
    // eliminates plurality target, resets vote flags — all inside TEE.
    const aliveWallets = Object.keys(game.players).filter(w => !game.players[w].isEliminated);
    try {
      const sig = await teeTallyCloseNight(game.numericId, aliveWallets);
      console.log(`[TEE ✓] tally_and_close_night: ${sig}`);
      io.to(gameId).emit("tee_update", { action: "endNight", txSig: sig, status: "ok" });
      await new Promise(r => setTimeout(r, 2000)); // let ER propagate
      // Read authoritative elimination result from ER
      const erState = await readGameStateFromER(game.numericId);
      if (erState?.nightEliminationTarget) eliminatedWallet = erState.nightEliminationTarget;
    } catch (e) {
      console.error(`[TEE ✗] tally night ${gameId}:`, e.message?.slice(0, 120));
      io.to(gameId).emit("tee_update", { action: "endNight", status: "failed" });
    }
    // Fallback: if ER tally returned no target, use server-tracked votes
    if (!eliminatedWallet) {
      const tally = {};
      Object.values(game.players).filter(p => p.role === "Mafia" && !p.isEliminated && p.nightVoteTarget)
        .forEach(p => { tally[p.nightVoteTarget] = (tally[p.nightVoteTarget] || 0) + 1; });
      const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      if (top) { eliminatedWallet = top[0]; console.log(`[Fallback] Night tally → ${eliminatedWallet}`); }
      // Doctor protection fallback: if doctor protected the target, save them
      if (eliminatedWallet && game.doctorProtectedWallet === eliminatedWallet) {
        console.log(`[Fallback] Doctor saved ${eliminatedWallet}`);
        eliminatedWallet = null;
      }
      game.doctorProtectedWallet = null; // reset each round
    }
  }

  let eliminatedRole = null;
  if (eliminatedWallet && game.players[eliminatedWallet]) {
    game.players[eliminatedWallet].isEliminated = true;
    eliminatedRole = game.players[eliminatedWallet].role;
  }

  const savedByDoctor = hadMafiaVotes && !eliminatedWallet;
  const winner = checkWinCondition(game);
  if (winner) { endGame(gameId, winner, eliminatedWallet, eliminatedRole); return; }

  game.phase = "Day"; game.round += 1; game.dayVotes = {};
  io.to(gameId).emit("night_result", { eliminatedWallet, eliminatedRole, savedByDoctor, round: game.round });
  startDayPhase(gameId);
}

function startDayPhase(gameId) {
  const game = games[gameId];
  if (!game) return;
  game.phase = "Day";
  io.to(gameId).emit("phase_change", { phase: "Day", round: game.round, durationMs: DAY_DURATION_MS });
  clearPhaseTimer(game);
  game.phaseTimer = setTimeout(() => endDayPhase(gameId), DAY_DURATION_MS + VOTE_GRACE_MS);
  if (game.teeEnabled && game.numericId) startVotePoller(gameId);
}

async function endDayPhase(gameId) {
  const game = games[gameId];
  if (!game || game.phase !== "Day") return;
  clearPhaseTimer(game);
  if (game && game.votePoller) { clearInterval(game.votePoller); game.votePoller = null; }

  let eliminatedWallet = null;

  if (game.teeEnabled && game.numericId) {
    // ── TEE: tally_and_close_day — AUTHORITATIVE on-chain vote tally ──
    // Pass all alive player PDAs. Rust program tallies, eliminates plurality,
    // resets vote flags — all inside Private ER (TEE). Server reads result.
    const aliveWallets = Object.keys(game.players).filter(w => !game.players[w].isEliminated);
    try {
      const sig = await teeTallyCloseDay(game.numericId, aliveWallets);
      console.log(`[TEE ✓] tally_and_close_day: ${sig}`);
      io.to(gameId).emit("tee_update", { action: "endDay", txSig: sig, status: "ok" });
      await new Promise(r => setTimeout(r, 2000)); // let ER propagate
      // Read authoritative elimination result from ER
      const erState = await readGameStateFromER(game.numericId);
      if (erState?.dayEliminationTarget) eliminatedWallet = erState.dayEliminationTarget;
    } catch (e) {
      console.error(`[TEE ✗] tally day ${gameId}:`, e.message?.slice(0, 120));
      io.to(gameId).emit("tee_update", { action: "endDay", status: "failed" });
    }
    // Fallback: if ER tally returned no target, use server-tracked votes (plurality)
    if (!eliminatedWallet) {
      const tally = {};
      Object.values(game.players).filter(p => !p.isEliminated && p.dayVoteTarget)
        .forEach(p => { tally[p.dayVoteTarget] = (tally[p.dayVoteTarget] || 0) + 1; });
      const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      if (top) { eliminatedWallet = top[0]; console.log(`[Fallback] Day tally → ${eliminatedWallet}`); }
    }
  }

  let eliminatedRole = null;
  if (eliminatedWallet && game.players[eliminatedWallet]) {
    game.players[eliminatedWallet].isEliminated = true;
    eliminatedRole = game.players[eliminatedWallet].role;
  }

  const winner = checkWinCondition(game);
  io.to(gameId).emit("day_result", { eliminatedWallet, eliminatedRole, round: game.round });
  if (winner) { setTimeout(() => endGame(gameId, winner, eliminatedWallet, eliminatedRole), 2000); return; }
  setTimeout(() => startNightPhase(gameId), 3000);
}

function endGame(gameId, winner, lastEliminated, lastRole) {
  const game = games[gameId];
  if (!game) return;
  clearPhaseTimer(game);
  game.phase = "GameOver"; game.winner = winner;

  const resultHash = computeResultHash(game);
  const allRoles = Object.fromEntries(Object.entries(game.players).map(([w, p]) => [w, p.role]));

  io.to(gameId).emit("game_over", {
    winner, allRoles, lastEliminated, lastRole, resultHash,
    vrfSeedHex: vrfSeedHex(game.vrfSeed),
    message: winner === "Mafia" ? "The Mafia has taken over!" : "The Citizens triumphed!",
  });

  // ── TEE: commit final state from TEE back to L1, then pay out winners ──
  if (game.teeEnabled && game.numericId) {
    setTimeout(async () => {
      try {
        const commitSig = await teeCommitGame(game.numericId);
        console.log(`[TEE ✓] commitGame ${gameId}: ${commitSig}`);
        io.to(gameId).emit("tee_update", { action: "commitGame", txSig: commitSig, status: "ok" });

        // Wait for undelegation to finalize on L1 before paying out
        await new Promise(r => setTimeout(r, 8000));

        const winners = Object.entries(game.players)
          .filter(([, p]) => !p.isEliminated && (winner === "Mafia" ? p.role === "Mafia" : p.role !== "Mafia"))
          .map(([w]) => w);

        if (winners.length > 0) {
          try {
            const payoutSig = await payoutGame(game.numericId, winners);
            console.log(`[TEE ✓] payout ${gameId}: ${payoutSig}`);
            io.to(gameId).emit("tee_update", { action: "payout", txSig: payoutSig, status: "ok" });
          } catch (e) {
            console.error(`[TEE ✗] payout ${gameId}:`, e.message?.slice(0, 120));
            io.to(gameId).emit("tee_update", { action: "payout", status: "failed" });
          }
        }
      } catch (e) {
        console.error(`[TEE ✗] commitGame ${gameId}:`, e.message?.slice(0, 120));
        io.to(gameId).emit("tee_update", { action: "commitGame", status: "failed" });
      }
    }, 6000);
  }

  setTimeout(() => { delete games[gameId]; }, 120_000);
}

// ═════════════════════════════════════════════════════════════════════════
// SOCKET HANDLERS
// ═════════════════════════════════════════════════════════════════════════
io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // ── Create game ──────────────────────────────────────────────────────
  socket.on("create_game", ({ gameId, walletAddress, username, stakeSOL, maxPlayers }) => {
    if (games[gameId]) { socket.emit("error", { message: "Game ID already exists." }); return; }

    const numericId = parseInt(gameId.replace("MAFIA", "")) || Math.floor(Math.random() * 90000 + 10000);

    games[gameId] = {
      gameId, hostWallet: walletAddress, hostSocketId: socket.id,
      phase: "Lobby", round: 1,
      players: {}, mafiaVotes: {}, dayVotes: {},
      chat: [], mafiaChat: [],
      phaseTimer: null,
      stakeSOL: stakeSOL || 0.1, maxPlayers: maxPlayers || 6,
      winner: null, vrfSeed: null,
      // TEE state
      numericId, teeEnabled: false, teeSigs: {},
    };

    socket.join(gameId);
    games[gameId].players[walletAddress] = {
      socketId: socket.id, walletAddress,
      username: username || walletAddress.slice(0, 6),
      role: null, isEliminated: false,
      hasVotedNight: false, hasVotedDay: false, hasProtected: false,
      nightTarget: null, dayVote: null,
    };

    const game = games[gameId];
    socket.emit("game_created", { gameId, stakeSOL, maxPlayers });
    socket.emit("game_state", {
      gameId, phase: game.phase, round: game.round,
      stakeSOL: game.stakeSOL, maxPlayers: game.maxPlayers,
      players: Object.values(game.players).map(p => ({ walletAddress: p.walletAddress, username: p.username, isEliminated: p.isEliminated })),
      chat: [],
    });
    io.to(gameId).emit("player_joined", { walletAddress, username, playerCount: Object.keys(game.players).length });

    // ── TEE: anchor GameState on L1 (no delegation yet — delegation happens at start_game
    //         so players can join_game on devnet before the account moves to ER) ──
    ;(async () => {
      try {
        io.to(gameId).emit("tee_update", { action: "setupGame", status: "pending" });
        await setupGameOnChain(numericId, maxPlayers || 6);
        if (games[gameId]) games[gameId].numericId = numericId; // ensure set after async
        console.log(`[TEE] Game ${gameId} (ID ${numericId}) anchored on L1 (awaiting start to delegate)`);
        io.to(gameId).emit("tee_update", { action: "setupGame", status: "ok" });
        // Signal host to sign their own join_game TX (creates PlayerState + wallet interaction)
        socket.emit("game_ready", { gameId, numericId });
      } catch (e) {
        console.error(`[TEE] Game ${gameId} setup failed:`, e?.message?.slice(0, 300) || String(e));
        io.to(gameId).emit("tee_update", { action: "setupGame", status: "failed" });
      }
    })();

    console.log(`Game ${gameId} created by ${username}`);
  });

  // ── Join game ────────────────────────────────────────────────────────
  socket.on("join_game", async ({ gameId, walletAddress, username }) => {
    const game = games[gameId];
    if (!game)                                              { socket.emit("error", { message: "Game not found." }); return; }
    if (game.phase !== "Lobby")                            { socket.emit("error", { message: "Game already started." }); return; }
    if (Object.keys(game.players).length >= game.maxPlayers) { socket.emit("error", { message: "Game is full." }); return; }
    if (game.players[walletAddress])                       { socket.emit("error", { message: "Already in this game." }); return; }

    // Verify player joined on-chain (GameState not yet delegated, still on L1).
    if (game.numericId && walletAddress) {
      try {
        const playerPDA = derivePlayerPDA(game.numericId, walletAddress);
        const acct = await devnetConn.getAccountInfo(playerPDA);
        if (!acct) {
          socket.emit("error", { message: "On-chain join required: please sign the join transaction with your wallet." });
          return;
        }
      } catch (e) {
        console.warn(`[Join] Devnet verify failed for ${walletAddress.slice(0,8)}..., allowing join:`, e.message);
      }
    }

    socket.join(gameId);
    game.players[walletAddress] = {
      socketId: socket.id, walletAddress,
      username: username || walletAddress.slice(0, 6),
      role: null, isEliminated: false,
      hasVotedNight: false, hasVotedDay: false, hasProtected: false,
      nightTarget: null, dayVote: null,
    };

    const playerCount = Object.keys(game.players).length;
    io.to(gameId).emit("player_joined", { walletAddress, username, playerCount });
    socket.emit("game_state", {
      gameId, phase: game.phase, round: game.round,
      stakeSOL: game.stakeSOL, maxPlayers: game.maxPlayers,
      players: Object.values(game.players).map(p => ({ walletAddress: p.walletAddress, username: p.username, isEliminated: p.isEliminated })),
      chat: game.chat.slice(-20),
    });

    // Re-emit current TEE status to the new player
    if (game.teeEnabled) socket.emit("tee_update", { action: "delegateGame", txSig: game.teeSigs.delegateGame, status: "ok" });

    console.log(`${username} joined ${gameId}. ${playerCount}/${game.maxPlayers}`);
  });

  // ── Start game ───────────────────────────────────────────────────────
  socket.on("start_game", async ({ gameId, walletAddress }) => {
    const game = games[gameId];
    if (!game)                              { socket.emit("error", { message: "Game not found." }); return; }
    if (game.hostWallet !== walletAddress)  { socket.emit("error", { message: "Only the host can start." }); return; }
    if (game.phase !== "Lobby")             { socket.emit("error", { message: "Already started." }); return; }
    if (Object.keys(game.players).length < 4) { socket.emit("error", { message: "Need at least 4 players." }); return; }

    // VRF seed: SHA-256(devnet_blockhash || sorted_player_pubkeys) — publicly verifiable
    const vrfSeedBytes = await getVrfSeed(Object.keys(game.players));
    game.vrfSeed = vrfSeedBytes;
    const roles = assignRoles(game.players, vrfSeedBytes);
    for (const [w, role] of Object.entries(roles)) game.players[w].role = role;
    game.phase = "Starting";

    const seedHash = crypto.createHash("sha256").update(Buffer.from(vrfSeedBytes)).digest("hex").slice(0, 16) + "...";
    io.to(gameId).emit("game_starting", {
      playerCount: Object.keys(game.players).length,
      vrfSeedHash: seedHash,
      message: `Roles sealed in Private ER (VRF: ${seedHash}).`,
    });

    for (const [wallet, player] of Object.entries(game.players)) {
      io.to(player.socketId).emit("role_assigned", {
        role: player.role,
        message: getRoleMessage(player.role, wallet, game),
      });
    }

    if (game.numericId) {
      const numId = game.numericId;
      const allWallets = Object.keys(game.players);

      io.to(gameId).emit("tee_update", { action: "setupGame", status: "pending" });

      ;(async () => {
        try {
          // ── Step A: Delegate GameState to ER ──────────────────────────────
          const delSig = await delegateGameTEE(numId);
          if (games[gameId]) { games[gameId].teeEnabled = true; games[gameId].teeSigs.delegateGame = delSig; }
          console.log(`[TEE ✓] Game ${gameId} delegated to ER: ${delSig}`);
          io.to(gameId).emit("tee_update", { action: "delegateGame", txSig: delSig, status: "ok" });
          await new Promise(r => setTimeout(r, 2000)); // let delegation finalize

          // ── Step B: Delegate each player's PlayerState to ER ──────────────
          for (const wallet of allWallets) {
            try {
              await delegatePlayerTEE(numId, wallet);
              console.log(`[TEE ✓] delegatePlayer ${wallet.slice(0,8)}...`);
            } catch (e) {
              console.warn(`[TEE] delegatePlayer failed ${wallet.slice(0,8)}...:`, e?.message?.slice(0,80));
            }
          }
          await new Promise(r => setTimeout(r, 3000));

          // ── Step C: assign_roles on ER — VRF seed → Fisher-Yates inside TEE ──
          const sig = await teeAssignRoles(numId, vrfSeedBytes);
          console.log(`[TEE ✓] ${gameId} assignRoles (VRF + roles on-chain): ${sig}`);
          io.to(gameId).emit("tee_update", { action: "assignRoles", txSig: sig, status: "ok" });

          // ── Step D: Read TEE-assigned roles from ER (server reads, not computes) ──
          await new Promise(r => setTimeout(r, 2000)); // let ER propagate
          const erRoles = await readGameRolesFromER(numId);
          if (erRoles) {
            // Sync server-side player roles to match what TEE assigned
            for (const [wallet, erRole] of Object.entries(erRoles)) {
              if (game.players[wallet]) {
                const jsRole = game.players[wallet].role;
                if (jsRole !== erRole) {
                  console.log(`[TEE] Role sync: ${wallet.slice(0,8)}... JS=${jsRole} → ER=${erRole}`);
                  game.players[wallet].role = erRole;
                }
              }
            }
            const erPlayerRoleMap = Object.fromEntries(Object.entries(erRoles).filter(([w]) => game.players[w]));
            if (Object.keys(erPlayerRoleMap).length > 0) {
              await teeSetPlayerRoles(numId, erPlayerRoleMap);
              io.to(gameId).emit("tee_update", { action: "setPlayerRoles", status: "ok" });
            }
          } else {
            // Fallback: use JS-computed roles (same algorithm, same result)
            if (allWallets.length > 0) {
              await teeSetPlayerRoles(numId, roles);
              io.to(gameId).emit("tee_update", { action: "setPlayerRoles", status: "ok" });
            }
          }
        } catch (e) {
          console.error(`[TEE] Role setup failed ${gameId}:`, e?.message?.slice(0,150));
          io.to(gameId).emit("tee_update", { action: "assignRoles", status: "failed" });
        } finally {
          startNightPhase(gameId);
        }
      })();
    } else {
      setTimeout(() => startNightPhase(gameId), 3500);
    }

    console.log(`Game ${gameId} started. VRF: ${seedHash}. TEE: ${game.teeEnabled}`);
  });

  // All votes happen on-chain via ER (Phantom wallet signs mafia_night_vote,
  // day_vote, and doctor_protect instructions directly on the ER endpoint).
  // Socket vote handlers removed — demo mode has been removed.

  // ── Vote submitted (on-chain ER vote acknowledgement from Phantom wallet) ─────
  socket.on("vote_submitted", ({ gameId, voterWallet, type, targetWallet }) => {
    const game = games[gameId];
    if (!game) return;
    const p = game.players[voterWallet];
    if (p) {
      if (type === "night") { p.hasVotedNight = true; if (targetWallet) p.nightVoteTarget = targetWallet; }
      if (type === "day")   { p.hasVotedDay   = true; if (targetWallet) p.dayVoteTarget   = targetWallet; }
    }
    socket.emit("vote_confirmed"); // acknowledge back to voter
    io.to(gameId).emit("player_voted", { voterWallet, type });
    // Broadcast live vote tallies for day phase
    if (type === "day" && game.phase === "Day") {
      const tallies = {};
      Object.values(game.players).filter(pl => !pl.isEliminated && pl.dayVoteTarget)
        .forEach(pl => { tallies[pl.dayVoteTarget] = (tallies[pl.dayVoteTarget] || 0) + 1; });
      const totalAlive = Object.values(game.players).filter(pl => !pl.isEliminated).length;
      const totalVoted = Object.values(game.players).filter(pl => !pl.isEliminated && pl.hasVotedDay).length;
      io.to(gameId).emit("vote_tallies", { tallies, totalVoted, totalAlive });
    }
  });

  // ── Doctor protect acknowledgement ───────────────────────────────────
  socket.on("protect_submitted", ({ gameId, doctorWallet, targetWallet }) => {
    const game = games[gameId];
    if (!game || game.phase !== "Night") return;
    const doctor = game.players[doctorWallet], target = game.players[targetWallet];
    if (!doctor || doctor.role !== "Doctor" || doctor.isEliminated) return;
    if (!target || target.isEliminated) return;
    game.doctorProtectedWallet = targetWallet; // track server-side for fallback
    socket.emit("protect_confirmed", { targetWallet, targetUsername: target.username });
  });

  // ── Public chat ──────────────────────────────────────────────────────
  socket.on("chat_message", ({ gameId, walletAddress, text }) => {
    const game = games[gameId];
    if (!game) return;
    const player = game.players[walletAddress];
    if (!player || !text || text.length > 300) return;
    const isGhost = player.isEliminated;
    const msg = {
      walletAddress,
      username: isGhost ? `💀 ${player.username}` : player.username,
      text: text.slice(0, 300), timestamp: Date.now(), isGhost,
    };
    game.chat.push(msg);
    if (game.chat.length > 100) game.chat.shift();
    io.to(gameId).emit("chat_message", msg);
  });

  // ── Mafia private chat (TEE-sealed: relay only to Mafia) ─────────────
  socket.on("mafia_chat", ({ gameId, walletAddress, text }) => {
    const game = games[gameId];
    if (!game || game.phase !== "Night") return;
    const player = game.players[walletAddress];
    if (!player || player.role !== "Mafia" || player.isEliminated || !text || text.length > 200) return;
    const msg = { walletAddress, username: player.username, text: text.slice(0, 200), timestamp: Date.now() };
    game.mafiaChat.push(msg);
    for (const p of Object.values(game.players)) {
      if (p.role === "Mafia" && p.socketId) io.to(p.socketId).emit("mafia_chat", msg);
    }
  });

  // ── Detective investigate ────────────────────────────────────────────
  socket.on("investigate", ({ gameId, detectiveWallet, targetWallet }) => {
    const game = games[gameId];
    if (!game || game.phase !== "Night") { socket.emit("investigation_result", { message: "Investigation failed: wrong phase.", isMafia: false }); return; }
    const detective = game.players[detectiveWallet], target = game.players[targetWallet];
    if (!detective || detective.role !== "Detective" || detective.isEliminated) { socket.emit("investigation_result", { message: "Investigation failed: not a detective.", isMafia: false }); return; }
    if (!target || target.isEliminated) { socket.emit("investigation_result", { message: "Investigation failed: invalid target.", isMafia: false }); return; }
    socket.emit("investigation_result", {
      targetWallet, targetUsername: target.username, isMafia: target.role === "Mafia",
      message: `${target.username} is ${target.role === "Mafia" ? "🔴 MAFIA!" : target.role === "Doctor" ? "💉 the Doctor" : "⚪ Not Mafia."}`,
    });
  });

  // ── Get game state ───────────────────────────────────────────────────
  socket.on("get_game_state", ({ gameId }) => {
    const game = games[gameId];
    if (!game) { socket.emit("error", { message: "Game not found." }); return; }
    socket.emit("game_state", {
      gameId, phase: game.phase, round: game.round,
      stakeSOL: game.stakeSOL, maxPlayers: game.maxPlayers,
      players: Object.values(game.players).map(p => ({ walletAddress: p.walletAddress, username: p.username, isEliminated: p.isEliminated })),
      chat: game.chat.slice(-20),
    });
    if (game.teeEnabled && game.teeSigs.delegateGame)
      socket.emit("tee_update", { action: "delegateGame", txSig: game.teeSigs.delegateGame, status: "ok" });
  });

  // ── Disconnect ───────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    for (const [gameId, game] of Object.entries(games)) {
      for (const [wallet, player] of Object.entries(game.players)) {
        if (player.socketId === socket.id) {
          player.socketId = null;
          io.to(gameId).emit("player_disconnected", { walletAddress: wallet, username: player.username });
          if (game.phase === "Lobby") {
            delete game.players[wallet];
            io.to(gameId).emit("player_left", { walletAddress: wallet, playerCount: Object.keys(game.players).length });
          }
        }
      }
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// HTTP ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", activeGames: Object.keys(games).length }));

app.get("/server-info", (_, res) => res.json({
  serverPubkey: serverKeypair.publicKey.toBase58(),
  programId: PROGRAM_ID.toBase58(),
  teeEndpoint: TEE_RPC,
  devnetRpc: DEVNET_RPC,
}));

/**
 * MagicBlock Crank endpoint — POST /crank/:gameId/:action
 * Crank is an on-chain scheduler that can hit this endpoint to trigger
 * phase transitions without manual intervention. Also callable manually.
 *
 * Supported actions:
 *   end_night — triggers endNightPhase (TEE tally + day transition)
 *   end_day   — triggers endDayPhase  (TEE tally + night/gameover transition)
 *
 * MagicBlock Crank config:
 *   url: https://<server>/crank/<gameId>/<action>
 *   method: POST
 *   interval: phase_duration_ms
 */
app.post("/crank/:gameId/:action", async (req, res) => {
  const { gameId, action } = req.params;
  const game = games[gameId];
  if (!game) return res.status(404).json({ error: "Game not found" });
  try {
    if (action === "end_night" && game.phase === "Night") {
      console.log(`[Crank] Triggered end_night for ${gameId}`);
      endNightPhase(gameId);
      return res.json({ status: "ok", action: "end_night", gameId });
    }
    if (action === "end_day" && game.phase === "Day") {
      console.log(`[Crank] Triggered end_day for ${gameId}`);
      endDayPhase(gameId);
      return res.json({ status: "ok", action: "end_day", gameId });
    }
    res.json({ status: "noop", phase: game.phase, action });
  } catch (e) {
    console.error(`[Crank] ${gameId}/${action} failed:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/game/:gameId", (req, res) => {
  const game = games[req.params.gameId];
  if (!game) return res.status(404).json({ error: "Not found" });
  res.json({
    gameId: game.gameId, phase: game.phase, round: game.round,
    playerCount: Object.keys(game.players).length, maxPlayers: game.maxPlayers,
    winner: game.winner, teeEnabled: game.teeEnabled,
    teeSigs: game.teeSigs || {},
    numericId: game.numericId,
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`\n🎭 Shadow Mafia TEE server on port ${PORT}\n`));
