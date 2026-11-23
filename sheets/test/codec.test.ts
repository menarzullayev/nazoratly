import { describe, expect, it } from "vitest";
import { decodeCell, decodeRows, encodeCell, encodeRow, type Cell } from "../src/gas/codec";
import { ALL_TABLES, ATTENDANCE, CHARGES, STUDENTS } from "../src/gas/schema";
import { parseUpdate } from "../src/domain/telegramUpdates";

const fmt = (d: Date): string => d.toISOString().slice(0, 10);
const col = (def: { cols: { key: string }[] }, key: string) => def.cols.find((c) => c.key === key) as never;

describe("schema", () => {
  it("has unique headers and keys per table and a key for every enum label set", () => {
    for (const t of ALL_TABLES) {
      expect(new Set(t.cols.map((c) => c.header)).size).toBe(t.cols.length);
      expect(new Set(t.cols.map((c) => c.key)).size).toBe(t.cols.length);
      for (const c of t.cols) if (c.kind === "enum") expect(Object.keys(c.labels ?? {}).length).toBeGreaterThan(1);
    }
  });
});

describe("codec", () => {
  it("decodes tolerant human input", () => {
    expect(decodeCell(col(CHARGES, "amount"), "1 200 000", fmt)).toBe(1_200_000);
    expect(decodeCell(col(CHARGES, "amount"), "", fmt)).toBe(0);
    expect(decodeCell(col(CHARGES, "amount"), "abc", fmt)).toBe(0);
    expect(decodeCell(col(CHARGES, "voided"), "Ha", fmt)).toBe(true);
    expect(decodeCell(col(CHARGES, "voided"), "yo'q", fmt)).toBe(false);
    expect(decodeCell(col(CHARGES, "voided"), true, fmt)).toBe(true);
    expect(decodeCell(col(ATTENDANCE, "status"), "KELMADI", fmt)).toBe("absent");
    expect(decodeCell(col(ATTENDANCE, "status"), "late", fmt)).toBe("late");
    expect(decodeCell(col(ATTENDANCE, "date"), new Date("2026-03-02T12:00:00Z"), fmt)).toBe("2026-03-02");
    expect(decodeCell(col(ATTENDANCE, "date"), "2026-03-02", fmt)).toBe("2026-03-02");
    expect(decodeCell(col(ATTENDANCE, "date"), "02.03.2026", fmt)).toBe(""); // unparseable dates never become wrong dates
    expect(decodeCell(col(STUDENTS, "fullName"), "  Ali  ", fmt)).toBe("Ali");
  });

  it("round-trips rows and survives reordered columns", () => {
    const header = ["Holat", "O'quvchi ID", "Sana", "Guruh ID", "Kechikish (daq)", "Qo'shimcha", "Demo"];
    const values: Cell[][] = [header, ["Kechikdi", "S0001", new Date("2026-03-02T12:00:00Z"), "G0001", 10, "izoh", ""], ["", "", "", "", "", "", ""]];
    const rows = decodeRows<Record<string, unknown>>(ATTENDANCE, values, fmt);
    expect(rows).toEqual([{ date: "2026-03-02", groupId: "G0001", studentId: "S0001", status: "late", minutesLate: 10, demo: false }]);
    const back = encodeRow(ATTENDANCE, header, rows[0]!, (iso) => new Date(`${iso}T12:00:00Z`));
    expect(back[0]).toBe("Kechikdi");
    expect(back[2]).toEqual(new Date("2026-03-02T12:00:00Z"));
    expect(back[5]).toBe(""); // unknown extra column left empty, never overwritten with data
  });

  it("explains a missing column instead of misreading data", () => {
    expect(() => decodeRows(ATTENDANCE, [["Sana", "Guruh ID"], ["2026-01-01", "G1"]], fmt)).toThrow(/ustun topilmadi/);
    expect(decodeRows(ATTENDANCE, [], fmt)).toEqual([]);
  });

  it("encodes enums, booleans and numbers for display", () => {
    expect(encodeCell(col(CHARGES, "voided"), true)).toBe("Ha");
    expect(encodeCell(col(CHARGES, "voided"), false)).toBe("Yo'q");
    expect(encodeCell(col(STUDENTS, "status"), "paused")).toBe("To'xtatilgan");
    expect(encodeCell(col(CHARGES, "amount"), "300000")).toBe(300_000);
    expect(encodeCell(col(CHARGES, "month"), "", () => new Date())).toBe("");
  });
});

describe("telegram updates", () => {
  const msg = (text: string, type = "private") => ({ message: { text, chat: { id: 42, type } } });
  it("parses /start with a link code and rejects malformed ones", () => {
    expect(parseUpdate(msg("/start abc12345XY"))).toEqual({ kind: "start", chatId: "42", code: "ABC12345XY" });
    expect(parseUpdate(msg("/start"))).toEqual({ kind: "start", chatId: "42", code: "" });
    expect(parseUpdate(msg("/start ../../etc"))).toEqual({ kind: "start", chatId: "42", code: "" });
    expect(parseUpdate(msg("/stop"))).toEqual({ kind: "stop", chatId: "42" });
    expect(parseUpdate(msg("salom"))).toEqual({ kind: "ignore" });
  });
  it("ignores group chats and garbage", () => {
    expect(parseUpdate(msg("/start ABC12345", "group"))).toEqual({ kind: "ignore" });
    expect(parseUpdate(null)).toEqual({ kind: "ignore" });
    expect(parseUpdate({ message: { text: "/start X", chat: {} } })).toEqual({ kind: "ignore" });
  });
  it("parses consent buttons", () => {
    const cb = (data: string) => ({ callback_query: { id: "cb1", data, message: { message_id: 7, chat: { id: 42, type: "private" } } } });
    expect(parseUpdate(cb("y:ABC12345"))).toEqual({ kind: "consent", chatId: "42", callbackId: "cb1", messageId: 7, accept: true, code: "ABC12345" });
    expect(parseUpdate(cb("n"))).toMatchObject({ kind: "consent", accept: false });
    expect(parseUpdate(cb("y:bad code"))).toEqual({ kind: "ignore" });
    expect(parseUpdate(cb("x:ABC12345"))).toEqual({ kind: "ignore" });
  });
});
