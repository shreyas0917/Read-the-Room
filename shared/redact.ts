// Per-player projection of the authoritative state. This is the ONLY way state
// leaves the server, so the privacy rules live here:
//
//  • During answer/predict, nobody sees anyone else's answer or prediction —
//    only who has submitted.
//  • After reveal, answers are shown only as an anonymous count per value.
//    Predictions and points are public once revealed.
//  • The Wildcard (unique extreme answer) is named — players are told this
//    in the rules before they answer.
//  • Tokens never live in RoomState, so they cannot leak through here.
//
// Note: with exactly two answers, the average plus your own answer implies the
// other answer. That is arithmetic, not a leak, and the rules say so.

import type { ClientView, PlayerView, PromptView, RevealView, RoomState, RoundSummary } from "./protocol";
import { getPrompt } from "./prompts";
import { ANSWER_MAX } from "./rules";
import { playersBySeat } from "./engine";
import { rankPlayers } from "./scoring";

function promptView(id: string): PromptView {
  const p = getPrompt(id);
  return { id: p.id, text: p.text, low: p.low, high: p.high };
}

function countAnswers(answers: Readonly<Record<string, number>>, ids: readonly string[]): number[] {
  const counts = new Array<number>(ANSWER_MAX).fill(0);
  for (const id of ids) {
    const v = answers[id];
    if (v !== undefined) counts[v - 1] = (counts[v - 1] ?? 0) + 1;
  }
  return counts;
}

export function viewFor(s: RoomState, viewerId: string | null, now: number): ClientView {
  const viewer = viewerId ? s.players[viewerId] : undefined;
  const r = s.current;
  const collecting = s.phase === "answer" || s.phase === "predict";
  const bucket = r && collecting ? (s.phase === "answer" ? r.answers : r.predictions) : null;

  const players: PlayerView[] = playersBySeat(s).map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    role: p.role,
    connected: p.connected,
    isHost: p.id === s.hostId,
    score: p.score,
    submitted: bucket && r?.participants.includes(p.id) ? bucket[p.id] !== undefined : null,
  }));

  const participants = r ? r.participants.filter((id) => s.players[id]) : [];
  const isParticipant = !!viewer && participants.includes(viewer.id);

  let reveal: RevealView | null = null;
  if (s.phase === "reveal" && r) {
    reveal = {
      voided: r.voided,
      average: r.average,
      counts: countAnswers(r.answers, r.participants),
      answerCount: r.participants.filter((id) => r.answers[id] !== undefined).length,
      yourAnswer: viewer ? (r.answers[viewer.id] ?? null) : null,
      wildcardId: r.wildcardId,
      guesses: r.participants.map((id) => ({
        playerId: id,
        value: r.predictions[id] ?? null,
        score: r.scores[id] ?? { prediction: null, error: null, base: 0, bullseye: 0, wildcard: 0, total: 0 },
      })),
    };
  }

  let rounds: RoundSummary[] | null = null;
  if (s.phase === "final") {
    rounds = s.history.map((h) => ({
      index: h.index,
      prompt: promptView(h.promptId),
      voided: h.voided,
      average: h.average,
      counts: countAnswers(h.answers, h.participants),
    }));
  }

  return {
    code: s.code,
    phase: s.phase,
    round: s.round,
    totalRounds: s.settings.rounds,
    deadline: s.deadline,
    serverNow: now,
    settings: { ...s.settings },
    hostId: s.hostId,
    you: viewer
      ? { id: viewer.id, role: viewer.role, isHost: viewer.id === s.hostId, participant: isParticipant }
      : null,
    players,
    prompt: r ? promptView(r.promptId) : null,
    submittedCount: bucket ? participants.filter((id) => bucket[id] !== undefined).length : 0,
    expectedCount: participants.length,
    mine: {
      answer: viewer && r ? (r.answers[viewer.id] ?? null) : null,
      prediction: viewer && r ? (r.predictions[viewer.id] ?? null) : null,
    },
    reveal,
    standings: s.phase === "final" ? rankPlayers(playersBySeat(s).filter((p) => p.role === "player")) : null,
    rounds,
    endedEarly: s.endedEarly,
  };
}
