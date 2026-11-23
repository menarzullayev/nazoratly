import { describe, expect, it } from "vitest";
import { convert, normalizeApostrophes, toCyrillic, toNewLatin } from "@/lib/translit";

describe("normalizeApostrophes", () => {
  it("maps every apostrophe variant to ASCII '", () => {
    expect(normalizeApostrophes("o‘g’ʻʼ")).toBe("o'g'''");
  });
});

describe("new Latin (2026 reform)", () => {
  it.each([
    ["O'zbekiston", "Özbekiston"],
    ["g'oya", "ğoya"],
    ["to'g'ri", "töğri"],
    ["shahar", "şahar"],
    ["choy", "çoy"],
    ["tong", "tong"],
    ["ma'no", "ma'no"],
    ["Sh", "Ş"],
    ["SHAHAR", "ŞAHAR"],
    ["Choy", "Çoy"],
    ["mas'ul", "mas'ul"],
    ["s'h", "s'h"],
  ])("%s -> %s", (src, want) => {
    expect(toNewLatin(src)).toBe(want);
  });

  it("treats all apostrophe variants alike", () => {
    for (const a of ["'", "‘", "’", "ʻ", "ʼ"]) {
      expect(toNewLatin(`O${a}zbek g${a}oya ma${a}no`)).toBe("Özbek ğoya ma'no");
    }
  });
});

describe("Cyrillic", () => {
  it.each([
    ["O'zbekiston", "Ўзбекистон"],
    ["g'oya", "ғоя"],
    ["shahar", "шаҳар"],
    ["choy", "чой"],
    ["yo'q", "йўқ"],
    ["yo'l", "йўл"],
    ["yozuv", "ёзув"],
    ["yulduz", "юлдуз"],
    ["yaxshi", "яхши"],
    ["yer", "ер"],
    ["sayyora", "сайёра"],
    ["ma'no", "маъно"],
    ["ma'lumot", "маълумот"],
    ["eski", "эски"],
    ["kelmoq", "келмоқ"],
    ["ng", "нг"],
    ["tsirk", "цирк"],
    ["otsiz", "отсиз"],
    ["Sh", "Ш"],
    ["SHAHAR", "ШАҲАР"],
    ["Qozon", "Қозон"],
  ])("%s -> %s", (src, want) => {
    expect(toCyrillic(src)).toBe(want);
  });

  it("treats all apostrophe variants alike", () => {
    for (const a of ["'", "‘", "’", "ʻ", "ʼ"]) {
      expect(toCyrillic(`o${a}zbek ma${a}no`)).toBe("ўзбек маъно");
    }
  });
});

describe("protected tokens and idempotence", () => {
  it("leaves handles, urls, tags, digits and {{marked}} text alone", () => {
    for (const to of ["cyrl", "new"] as const) {
      expect(convert("@nazoratlybot", to)).toBe("@nazoratlybot");
      expect(convert("+998902336600", to)).toBe("+998902336600");
      expect(convert("https://t.me/menarzullayev", to)).toBe("https://t.me/menarzullayev");
      expect(convert('<a href="https://t.me/x">shahar</a>', to)).toContain('<a href="https://t.me/x">');
      expect(convert("{{nazoratly}} shahar", to)).toContain("{{nazoratly}}");
    }
  });

  it("is idempotent on its own output", () => {
    const src = "O'zbekistonda g'oya shahar yo'q, ma'no choy.";
    const c = toCyrillic(src);
    const n = toNewLatin(src);
    expect(toCyrillic(c)).toBe(c);
    expect(toNewLatin(n)).toBe(n);
  });

  it("latn is a no-op apart from apostrophe normalisation", () => {
    expect(convert("O‘zbek", "latn")).toBe("O'zbek");
  });
});
