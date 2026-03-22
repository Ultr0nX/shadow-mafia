# Shadow Mafia — On-Chain Social Deduction

**A Mafia / Among Us style game built on Solana where your role is a secret sealed inside a cryptographic vault — not even the server knows who is Mafia.**

Built for: **Solana Blitz v2 Hackathon** · Theme: **Privacy using MagicBlock Ephemeral Rollups**

Live demo: [shadow-mafia.vercel.app](https://shadow-mafia.vercel.app)
Program ID: `4jEx2Z526KdKe97TKqf7kZnkdM3LBDtH6Et5n2cJnam8` (Solana Devnet)

---

## ⚠️ Important Note on Private ER Access

This project is built to use MagicBlock's **Private Ephemeral Rollup** (`tee.magicblock.app`) — an Intel TDX hardware TEE that provides true hardware-level privacy.

We reached out to the MagicBlock team to get an API token for `tee.magicblock.app` but did not receive access in time for the submission deadline.

As a result, the game currently runs on **`devnet.magicblock.app`** — MagicBlock's public Ephemeral Rollup endpoint. This is functionally identical (same SDK, same Anchor macros, same instruction flow, same delegation pattern) — the only difference is that `devnet.magicblock.app` does not have Intel TDX hardware encryption. All the ER infrastructure, delegation, on-chain vote tallying, and commit-back to L1 still work exactly as designed.

The code is ready for `tee.magicblock.app` — switching is a single environment variable change:
```
TEE_RPC=https://tee.magicblock.app?token=YOUR_TOKEN
```

---

## What is Shadow Mafia?

Shadow Mafia is a real-money social deduction game. Players stake SOL to enter, get secretly assigned roles, and try to eliminate each other through private votes. The last faction standing wins the entire pot — paid out automatically by a smart contract.

The core idea: **social deduction games are impossible without hidden information**. If anyone can see who is Mafia, the game is over before it starts. Traditional versions rely on trusting a server to keep secrets. We replaced that trust with cryptography.

Every role assignment, every vote, every elimination happens inside an on-chain Rust program running in an Ephemeral Rollup. The server cannot see individual votes. It cannot change who dies. It just triggers the Rust instructions and reads the result.

---

## The Roles

| Role | Goal |
|------|------|
| 🔴 **Mafia** | Eliminate Citizens without getting caught. Win when you equal or outnumber them. |
| ⚪ **Citizen** | Find and exile the Mafia through group voting. Win when all Mafia are gone. |
| 💉 **Doctor** | Protect one player per night from elimination. (Added when 5+ players join) |

---

## How to Play

### 1. Join the Lobby
- Open the app and connect your Phantom wallet (set to Devnet)
- Pick an alias — this is your in-game name
- Create a game or enter a friend's game code
- Sign the `join_game` transaction — this locks your stake in the smart contract and creates your player account on-chain

### 2. Game Starts (4–8 players)
- Host clicks **Start Game**
- A random seed is generated from the current Solana blockhash + all player wallet addresses — publicly verifiable, cannot be manipulated
- The game accounts are delegated to the Ephemeral Rollup
- Roles are assigned by a Fisher-Yates shuffle running inside the ER, sealed on-chain
- You get one Phantom popup to create a session key — every vote after that is instant, no popup

### 3. Night Phase (60 seconds)
- **Mafia** selects a target and signs a `mafia_night_vote` transaction directly to the ER
- **Doctor** picks someone to protect — signs a `doctor_protect` transaction
- **Citizens** wait
- When time runs out, `tally_and_close_night` runs on-chain: reads all votes, checks the Doctor's protection, eliminates the target (or saves them), transitions to Day

### 4. Day Phase
- Everyone finds out what happened during the night (who died, or that the Doctor saved someone)
- All alive players talk it out in chat and debate who the Mafia might be
- Each player signs a `day_vote` ER transaction — votes are hidden while voting is open
- `tally_and_close_day` runs on-chain: tallies votes, exiles the plurality target, announces the result

### 5. Keep going until...
- **Mafia wins** — when they equal or outnumber the surviving Citizens
- **Citizens win** — when all Mafia members are eliminated

### 6. Payout
- Final game state is committed from the ER back to Solana L1
- `payout` instruction splits the SOL pot equally among the winning team
- Winners receive SOL directly in their wallets — automated, no intermediary

---

## Why This Game Had to Be Built on Private ERs

This is not a case of "using blockchain for the sake of it." The game is literally unplayable without a privacy layer.

**Problem with traditional approaches:**

| What needs to stay secret | Traditional solution | Shadow Mafia |
|---------------------------|---------------------|--------------|
| Who is Mafia | Server knows, players trust it | Sealed inside ER — server cannot read |
| Night vote targets | Server stores privately | Written to ER, only readable by tally instruction |
| Day votes while open | Hidden by server | Written to ER, revealed only after tally |
| Doctor's protection choice | Stored on server | Written to ER, checked atomically during tally |

With a traditional server, you're trusting that the server won't cheat. With Shadow Mafia, there's no trust required — the game logic runs in Rust and the state is sealed in an Ephemeral Rollup.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                      PLAYER'S BROWSER                         │
│                                                               │
│   Next.js UI  ←→  Phantom Wallet    ←→  Burner Keypair       │
│   (game board)     (L1 join/stake)       (session key,        │
│                                           signs ER votes)     │
│                                                               │
│   Votes go DIRECTLY from browser → ER endpoint               │
│   (server never sees the vote content)                        │
└───────────────────────┬───────────────────────────────────────┘
                        │ Socket.io (real-time events only)
                        │ e.g. "night started", "player died"
                        ▼
┌───────────────────────────────────────────────────────────────┐
│                   GAME SERVER (Node.js / Render)              │
│                                                               │
│   What it does:                                               │
│   • Relays chat between players                               │
│   • Watches the ER for vote completion                        │
│   • Triggers tally instructions when phase timers end         │
│   • Reads results from ER and broadcasts to players           │
│                                                               │
│   What it CANNOT do:                                          │
│   • Read individual vote targets                              │
│   • Change who gets eliminated                                │
│   • Alter role assignments                                    │
└──────────┬────────────────────────────────────┬───────────────┘
           │                                    │
           ▼                                    ▼
┌──────────────────────┐          ┌─────────────────────────────┐
│  SOLANA DEVNET (L1)  │          │  MAGICBLOCK EPHEMERAL ROLLUP│
│                      │          │  (devnet.magicblock.app)    │
│  • Game creation     │          │                             │
│  • Player staking    │  commit  │  All game logic runs here:  │
│  • Final results     │◄─────────│  • assign_roles (VRF)       │
│  • SOL payout        │          │  • mafia_night_vote         │
│  • VRF seed (public) │          │  • doctor_protect           │
│                      │          │  • day_vote                 │
│                      │          │  • tally_and_close_night    │
│                      │          │  • tally_and_close_day      │
│                      │          │  • end_game                 │
└──────────────────────┘          └─────────────────────────────┘
```

---

## How MagicBlock's ER Is Used

### `#[ephemeral]` — The whole program runs on ERs

```rust
#[ephemeral]
#[program]
pub mod shadow_mafia { ... }
```

### `#[delegate]` — Moving game state into the ER

When the host starts a game, `GameState` and every player's `PlayerState` are delegated from Solana L1 to the ER. After delegation, all game logic runs on the rollup — fast, private, and settled later.

### `#[session_auth_or]` — Gasless votes

```rust
#[session_auth_or(
    ctx.accounts.player_state.player == ctx.accounts.signer.key(),
    SessionError::InvalidToken
)]
pub fn mafia_night_vote(...) -> Result<()> { ... }
```

Applied to all three action instructions (`mafia_night_vote`, `doctor_protect`, `day_vote`). Players sign once at game start to create a session key — after that, votes are signed by a burner keypair in-browser. No Phantom popup for every action.

### `#[commit]` — Writing results permanently to L1

When the game ends, `end_game` commits the final `GameState` back to Solana L1. The winner, all eliminations, and the VRF seed become permanent public record.

### Crank endpoint

```
POST /crank/:gameId/end_night
POST /crank/:gameId/end_day
```

The server exposes Crank-compatible HTTP endpoints so MagicBlock's Crank service can trigger phase transitions automatically.

---

## How Roles Are Assigned (Verifiable Randomness)

The role shuffle uses a seed that nobody — not the server, not a player — can predict or manipulate:

```
VRF Seed = SHA-256(latest_solana_blockhash + sorted_player_pubkeys)
```

- The **blockhash** is from Solana devnet at the moment the game starts — unpredictable
- The **sorted player pubkeys** are fixed once the lobby closes
- This seed is passed to `assign_roles` inside the ER, which runs a Fisher-Yates shuffle
- The seed is stored publicly in `game_state.vrf_seed` on L1 — anyone can verify the result was fair

---

## On-Chain Instructions

### L1 Instructions (Solana Devnet)

| Instruction | Called by | Purpose |
|-------------|-----------|---------|
| `create_game` | Server | Create GameState PDA, set stake amount |
| `join_game` | Each player (Phantom) | Transfer stake SOL, create PlayerState |
| `delegate_game` | Server | Move GameState from L1 → ER |
| `delegate_player` | Server | Move each PlayerState from L1 → ER |
| `payout` | Server | Split pot to winners |

### ER Instructions (Ephemeral Rollup)

| Instruction | Called by | Purpose |
|-------------|-----------|---------|
| `assign_roles` | Server | VRF Fisher-Yates role shuffle inside ER |
| `set_player_role` | Server | Store each player's role in their PlayerState |
| `mafia_night_vote` | Mafia player | Record elimination target (private) |
| `doctor_protect` | Doctor player | Set protection target (private) |
| `day_vote` | Every player | Record exile vote (private until tally) |
| `tally_and_close_night` | Server | Count votes, check doctor, eliminate, advance phase |
| `tally_and_close_day` | Server | Count votes, exile player, advance phase |
| `end_game` | Server | Commit final state from ER → L1 |

---

## Running Locally

**You need:** Node.js 18+, Phantom Wallet (set to Devnet), devnet SOL

```bash
git clone https://github.com/Ultr0nX/shadow-mafia.git
cd shadow-mafia

# Start the server
cd server
npm install
node index.js
# Note the server wallet address and airdrop SOL to it:
# solana airdrop 2 <address> --url devnet

# Start the frontend (new terminal)
cd ../app
npm install
npm run dev
```

Open `http://localhost:3000`. To play a full game you need 4 browser windows with 4 different Phantom wallets (all with devnet SOL).

---

## Project Structure

```
shadow-mafia/
├── programs/shadow-mafia/src/lib.rs   ← Anchor program (Solana devnet)
├── server/index.js                    ← Node.js relay + ER transaction builder
├── app/app/page.tsx                   ← Next.js frontend (full game UI)
├── server/railway.json                ← Render/Railway deployment config
└── README.md
```

---

## Tech Stack

- **Solana** — L1 blockchain (devnet)
- **Anchor** — Rust smart contract framework
- **MagicBlock Ephemeral Rollups SDK** — `#[ephemeral]`, `#[delegate]`, `#[commit]`, `#[session_auth_or]`
- **Next.js 14 / React 19** — frontend
- **Socket.io** — real-time event relay
- **Phantom Wallet** — player wallet + signing
- **Render** — server hosting (free tier)
- **Vercel** — frontend hosting (free tier)

---

*Solana Blitz v2 Hackathon — MagicBlock Privacy Track*
*Built by Sunil Pitti (@Ultr0nX)*
