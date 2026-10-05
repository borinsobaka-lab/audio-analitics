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


def split_into_blocks(
    turns: list[Turn], gap_s: float, max_chars: int
) -> list[list[Turn]]:
    """Cut the day's turns into blocks small enough for one model request.

    The whole day used to go to the model in a single request. On a real
    shift that is hours of speech in Russian and Georgian plus an answer that
    lists a hundred dialogs: either side can outgrow the request limits, and
    the failure mode was the entire day marked «error». Blocks are cut only
    at pauses longer than `gap_s`, so a dialog is never split in the middle;
    conversations are packed greedily until the rendered text would exceed
    `max_chars`. A single conversation longer than the budget is split at its
    longest internal pause, recursively, and only as a last resort by count.
    """
    if not turns:
        return []

    def size(items: list[Turn]) -> int:
        return len(render_transcript(items))

    def split_long(items: list[Turn]) -> list[list[Turn]]:
        if size(items) <= max_chars or len(items) < 2:
            return [items]
        # Longest pause inside the conversation, ties → closest to the middle.
        best_idx = max(
            range(1, len(items)),
            key=lambda i: (
                items[i].start - items[i - 1].end,
                -abs(i - len(items) / 2),
            ),
        )
        return split_long(items[:best_idx]) + split_long(items[best_idx:])

    blocks: list[list[Turn]] = []
    current: list[Turn] = []
    for conv in group_conversations(turns, gap_s):
        for piece in split_long(conv.turns):
            if current and size(current) + size(piece) + 1 > max_chars:
                blocks.append(current)
                current = []
            current.extend(piece)
    if current:
        blocks.append(current)
    return blocks


def format_ts(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def render_transcript(turns: list[Turn]) -> str:
    """Human/LLM-readable transcript: [HH:MM:SS] speaker: text"""
    return "\n".join(f"[{format_ts(t.start)}] {t.speaker}: {t.text}" for t in turns)
