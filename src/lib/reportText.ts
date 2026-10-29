// Labels for awards/highlights and the plain-text Room Report a player can
// copy or share. Pure, so it's unit-tested. The text contains only what the
// report contains (names, scores, averages, Echo outcomes) — never answers.

import type { Award, EchoRoundReport, Moment, PlayerView, RoomReport, RoundReport, Standing } from "../../shared/protocol";

export const MODE_NAME = { count: "Higher or lower", pattern: "Room pattern", who: "Who said it?" } as const;

const METRIC = { highest: "highest average", lowest: "lowest average", split: "most divided" } as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const AWARD_META: Record<Award["id"], { icon: string; title: string; describe: (v: number) => string }> = {
  mind_reader: { icon: "🧠", title: "Mind Reader", describe: (v) => `Closest predictions: off by ${v.toFixed(2)} on average` },
  bullseye_king: { icon: "🎯", title: "Bullseye King", describe: (v) => plural(v, "bullseye") },
  wildcard: { icon: "🃏", title: "Wildcard", describe: (v) => `Boldest answer in the room ${plural(v, "time")}` },
  echo_master: { icon: "⟲", title: "Echo Master", describe: (v) => `${v} points from Echo Rounds` },
  poker_face: { icon: "🤫", title: "Poker Face", describe: (v) => `Fooled ${plural(v, "player")} in Who said it?` },
};

export type NameOf = (id: string) => string;

export function joinNames(ids: readonly string[], name: NameOf): string {
  const n = ids.map(name);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} & ${n[n.length - 1]}`;
}

export function momentText(m: Moment, name: NameOf): { title: string; body: string } {
  switch (m.kind) {
    case "closest_call":
      return {
        title: "Closest call",
        body:
          m.error < 0.005
            ? `Round ${m.round}: ${joinNames(m.playerIds, name)} nailed the room's ${m.average.toFixed(1)} exactly`
            : `Round ${m.round}: ${joinNames(m.playerIds, name)} was off by just ${m.error.toFixed(2)}`,
      };
    case "most_divided":
      return { title: "Most divided", body: `“${m.prompt.text}” (spread ${m.spread.toFixed(1)})` };
    case "most_agreed":
      return { title: "Most in sync", body: `“${m.prompt.text}” (spread ${m.spread.toFixed(1)})` };
    case "best_echo":
      return { title: "Sharpest memory", body: `Round ${m.round} ${MODE_NAME[m.mode]}: ${m.correct} of ${m.guessers} got it` };
  }
}

/** The correct answer of an Echo Round as a short phrase. */
export function echoAnswer(r: EchoRoundReport, name: NameOf): string {
  if (r.cancelled) return "cancelled";
  if (r.mode === "count") return `answer ${r.truth}`;
  if (r.mode === "pattern") return `“${r.promptOptions?.[r.truth]?.text ?? "?"}”`;
  return r.revealedSubject ? `it was ${name(r.revealedSubject)}` : "—";
}

export function echoQuestion(r: EchoRoundReport): string {
  if (r.mode === "count") return `How many answered above ${r.threshold} on “${r.prompt?.text ?? ""}”?`;
  if (r.mode === "pattern") return `Which question had the ${METRIC[r.metric ?? "highest"]}?`;
  return `Who answered ${r.value} on “${r.prompt?.text ?? ""}”?`;
}

export function roundLine(r: RoundReport, name: NameOf): string {
  if (r.kind === "regular") {
    if (r.voided || r.average === null) return `R${r.index} “${r.prompt.text}”: not enough answers`;
    const closest = r.closest ? ` · closest: ${joinNames(r.closest.playerIds, name)}` : "";
    return `R${r.index} “${r.prompt.text}”: room said ${r.average.toFixed(1)}${closest}`;
  }
  const score = r.cancelled ? "" : ` · ${r.correct}/${r.guessers} right`;
  return `R${r.index} ⟲ ${MODE_NAME[r.mode]}: ${echoAnswer(r, name)}${score}`;
}

export function reportText(report: RoomReport, standings: readonly Standing[], players: readonly PlayerView[], url: string): string {
  const byId = new Map(players.map((p) => [p.id, p.name]));
  const name: NameOf = (id) => byId.get(id) ?? "someone";
  const lines: string[] = [];
  lines.push(`READ THE ROOM · room ${report.code}`);
  const winners = standings.filter((s) => s.rank === 1);
  if (winners.length) {
    const head = winners.length > 1 ? `${joinNames(winners.map((w) => w.playerId), name)} tie` : `${name(winners[0]!.playerId)} wins`;
    lines.push(`🏆 ${head} with ${winners[0]!.score} pts${report.endedEarly ? " (ended early)" : ""}`);
  }
  lines.push(standings.map((s) => `${s.rank}. ${name(s.playerId)} ${s.score}`).join(" · "));
  if (report.awards.length) {
    lines.push("");
    for (const a of report.awards) {
      const meta = AWARD_META[a.id];
      lines.push(`${meta.icon} ${meta.title}: ${joinNames(a.winners, name)} (${meta.describe(a.value)})`);
    }
  }
  if (report.moments.length) {
    lines.push("");
    for (const m of report.moments) {
      const t = momentText(m, name);
      lines.push(`• ${t.title}: ${t.body}`);
    }
  }
  lines.push("");
  for (const r of report.rounds) lines.push(roundLine(r, name));
  lines.push("", `Play: ${url}`);
  return lines.join("\n");
}
