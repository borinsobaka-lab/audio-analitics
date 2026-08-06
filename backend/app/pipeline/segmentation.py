"""Turn ASR words into speaker turns and pre-split them into conversations.

The LLM does the semantic split (stage 1); this module only prepares a
readable transcript with timestamps and a coarse pause-based grouping to keep
LLM inputs bounded.
"""
from dataclasses import dataclass, field

from .asr import Word

TURN_GAP_S = 2.0  # new turn after this pause even for the same speaker


@dataclass
class Turn:
    speaker: str
    start: float
    end: float
    text: str


@dataclass
class Conversation:
    start: float
    end: float
    turns: list[Turn] = field(default_factory=list)


def words_to_turns(words: list[Word]) -> list[Turn]:
    turns: list[Turn] = []
    for w in words:
        if (
            turns
            and turns[-1].speaker == w.speaker
            and w.start - turns[-1].end <= TURN_GAP_S
        ):
            turns[-1].text = f"{turns[-1].text} {w.text}".strip()
            turns[-1].end = w.end
        else:
            turns.append(Turn(speaker=w.speaker, start=w.start, end=w.end, text=w.text))
    return turns


def group_conversations(turns: list[Turn], gap_s: float) -> list[Conversation]:
    """Split turns into conversations at pauses longer than gap_s."""
    conversations: list[Conversation] = []
    for turn in turns:
        if conversations and turn.start - conversations[-1].end <= gap_s:
            conv = conversations[-1]
            conv.turns.append(turn)
            conv.end = max(conv.end, turn.end)
        else:
            conversations.append(
                Conversation(start=turn.start, end=turn.end, turns=[turn])
            )
    return conversations


def format_ts(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def render_transcript(turns: list[Turn]) -> str:
    """Human/LLM-readable transcript: [HH:MM:SS] speaker: text"""
    return "\n".join(f"[{format_ts(t.start)}] {t.speaker}: {t.text}" for t in turns)
