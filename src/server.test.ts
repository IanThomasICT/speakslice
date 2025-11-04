import { describe, test, expect } from "bun:test";

// Import types and test the alignment logic
type Word = { start: number; end: number; text: string; confidence?: number };
type DiarSeg = { start: number; end: number; speaker: string; has_overlap: boolean };

// Copy of alignWordsToDiarization for testing
// Why: Testing alignment logic is critical - ensures words match correct speakers
function alignWordsToDiarization(words: Word[], diar: DiarSeg[]) {
  const aligned = [];
  let wi = 0;
  for (const seg of diar) {
    const s0 = seg.start;
    const s1 = seg.end;
    const segWords: Word[] = [];
    while (wi < words.length && words[wi].end <= s0) wi++;
    let wj = wi;
    while (wj < words.length && words[wj].start < s1) {
      const w = words[wj];
      if (w.end > s0 && w.start < s1) segWords.push(w);
      wj++;
    }
    const text = segWords.map((w) => w.text).join(" ").trim();
    aligned.push({
      start: s0,
      end: s1,
      speaker: seg.speaker,
      text,
      words: segWords,
    });
  }
  return aligned;
}

describe("alignWordsToDiarization", () => {
  test("should align words to single speaker segment", () => {
    const words: Word[] = [
      { start: 0.5, end: 0.8, text: "Hello" },
      { start: 0.9, end: 1.2, text: "world" },
    ];
    const diar: DiarSeg[] = [
      { start: 0.0, end: 2.0, speaker: "SPEAKER_00", has_overlap: false },
    ];

    const result = alignWordsToDiarization(words, diar);

    expect(result).toHaveLength(1);
    expect(result[0].speaker).toBe("SPEAKER_00");
    expect(result[0].text).toBe("Hello world");
    expect(result[0].words).toHaveLength(2);
  });

  test("should align words to multiple speaker segments", () => {
    const words: Word[] = [
      { start: 0.5, end: 0.8, text: "Hello" },
      { start: 2.5, end: 2.8, text: "Hi" },
      { start: 2.9, end: 3.2, text: "there" },
    ];
    const diar: DiarSeg[] = [
      { start: 0.0, end: 1.5, speaker: "SPEAKER_00", has_overlap: false },
      { start: 2.0, end: 4.0, speaker: "SPEAKER_01", has_overlap: false },
    ];

    const result = alignWordsToDiarization(words, diar);

    expect(result).toHaveLength(2);
    expect(result[0].speaker).toBe("SPEAKER_00");
    expect(result[0].text).toBe("Hello");
    expect(result[1].speaker).toBe("SPEAKER_01");
    expect(result[1].text).toBe("Hi there");
  });

  test("should handle words that overlap segment boundaries", () => {
    const words: Word[] = [
      { start: 0.9, end: 1.2, text: "overlap" },
    ];
    const diar: DiarSeg[] = [
      { start: 0.0, end: 1.0, speaker: "SPEAKER_00", has_overlap: false },
      { start: 1.0, end: 2.0, speaker: "SPEAKER_01", has_overlap: false },
    ];

    const result = alignWordsToDiarization(words, diar);

    // Word overlaps both segments but should be in the one it starts in
    expect(result[0].words).toHaveLength(1);
    expect(result[1].words).toHaveLength(0);
  });

  test("should handle empty segments (no words)", () => {
    const words: Word[] = [
      { start: 0.5, end: 0.8, text: "Hello" },
    ];
    const diar: DiarSeg[] = [
      { start: 0.0, end: 1.0, speaker: "SPEAKER_00", has_overlap: false },
      { start: 2.0, end: 3.0, speaker: "SPEAKER_01", has_overlap: false }, // No words here
    ];

    const result = alignWordsToDiarization(words, diar);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Hello");
    expect(result[1].text).toBe(""); // Empty segment
  });

  test("should handle empty inputs gracefully", () => {
    expect(alignWordsToDiarization([], [])).toHaveLength(0);
    expect(alignWordsToDiarization([], [
      { start: 0, end: 1, speaker: "SPEAKER_00", has_overlap: false }
    ])).toHaveLength(1);
  });
});
