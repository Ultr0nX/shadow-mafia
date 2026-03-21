// TEE end-to-end test: create -> start -> vote night -> check all TEE events
import { io } from "socket.io-client";

const HOST = "http://localhost:3001";
const GAME_ID = `MAFIA${Math.floor(Math.random() * 90000 + 10000)}`;
const PLAYERS = ["Alice", "Bob", "Carol", "Dave"];

const sockets = {};
const teeEvents = [];
let roles = {};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log(`=== TEE End-to-End Test (gameId: ${GAME_ID}) ===\n`);

  // Connect 4 players
  for (const name of PLAYERS) {
    sockets[name] = io(HOST);
    await new Promise(r => sockets[name].on("connect", r));
    console.log(`[+] ${name} connected`);
  }

  // Listen for tee_update on all sockets
  for (const [name, s] of Object.entries(sockets)) {
    s.on("tee_update", (data) => {
      if (!teeEvents.find(e => e.action === data.action && e.status === data.status && e.txSig === data.txSig)) {
        teeEvents.push(data);
        console.log(`\n[TEE] ${data.action} → ${data.status}${data.txSig ? " txSig=" + data.txSig.slice(0,20) + "..." : ""}`);
      }
    });
    s.on("role_assigned", (data) => {
      if (data.role) {
        roles[name] = data.role;
        console.log(`  ${name} role: ${data.role}`);
      }
    });
    s.on("phase_change", (data) => {
      console.log(`  Phase: ${data.phase}`);
    });
  }

  const wallets = {
    Alice: "AliceDemo",
    Bob:   "BobDemo",
    Carol: "CarolDemo",
    Dave:  "DaveDemo",
  };

  console.log("\n--- Creating game as Alice ---");
  sockets["Alice"].emit("create_game", { gameId: GAME_ID, username: "Alice", walletAddress: wallets.Alice });
  await sleep(18000); // wait for L1 setup (create_game + 4×join_game) + delegate → can take 15s on devnet

  console.log("\n--- Joining as Bob, Carol, Dave ---");
  for (const name of ["Bob", "Carol", "Dave"]) {
    sockets[name].emit("join_game", { gameId: GAME_ID, username: name, walletAddress: wallets[name] });
  }
  await sleep(1000);

  console.log("\n--- Starting game as Alice ---");
  sockets["Alice"].emit("start_game", { gameId: GAME_ID, walletAddress: wallets.Alice });
  await sleep(20000); // wait for assign_roles on TEE (can be slow)

  console.log("\n--- Casting mafia night vote ---");
  // Mafia votes to eliminate a citizen
  const mafia = Object.entries(roles).find(([, r]) => r === "Mafia")?.[0];
  const citizen = Object.entries(roles).find(([, r]) => r === "Citizen")?.[0];
  if (mafia && citizen) {
    console.log(`  ${mafia} (Mafia) votes to eliminate ${citizen} (Citizen)`);
    sockets[mafia].emit("mafia_vote", { gameId: GAME_ID, voterWallet: wallets[mafia], targetWallet: wallets[citizen] });
    await sleep(25000); // wait for endNightPhase + TEE tally_and_close_night on ER
  } else {
    console.log(`  Roles unknown, skipping vote. Roles: ${JSON.stringify(roles)}`);
    await sleep(5000);
  }

  console.log("\n\n=== Final TEE Events ===");
  const unique = [];
  for (const e of teeEvents) {
    if (!unique.find(u => u.action === e.action && u.txSig === e.txSig)) unique.push(e);
  }
  for (const e of unique) {
    console.log(`  ${e.action.padEnd(15)} ${e.status.padEnd(8)} ${e.txSig || "none"}`);
  }

  const ok = [...new Set(unique.filter(e => e.status === "ok").map(e => e.action))];
  const fail = [...new Set(unique.filter(e => e.status === "failed").map(e => e.action))];
  console.log("\nPassed:", ok.join(", ") || "none");
  console.log("Failed:", fail.join(", ") || "none");

  for (const s of Object.values(sockets)) s.disconnect();
  console.log("\nDone.");
}

run().catch(console.error);
