import { csvCell, toCsv } from "../../src/modules/admin/admin.service";

/**
 * CSV export has two independent failure modes and both are security-relevant:
 * a structural break, and a formula that executes on the reader's machine.
 */
describe("CSV export escaping", () => {
  it("leaves an ordinary value alone", () => {
    expect(csvCell("Ada Cruz")).toBe("Ada Cruz");
    expect(csvCell(1234)).toBe("1234");
  });

  it("quotes a value containing a comma", () => {
    expect(csvCell("Cruz, Ada")).toBe('"Cruz, Ada"');
  });

  it("doubles embedded quotes and wraps the field", () => {
    expect(csvCell('Ada "AJ" Cruz')).toBe('"Ada ""AJ"" Cruz"');
  });

  it("quotes a value containing a newline, so the row does not split", () => {
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
  });

  it("renders null and undefined as an empty field", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it.each([
    ["equals", "=1+1"],
    ["plus", "+1"],
    ["minus", "-1"],
    ["at", "@SUM(A1)"],
  ])("neutralises a formula-injection payload starting with %s", (_label, payload) => {
    const out = csvCell(payload);
    // A leading apostrophe makes Excel treat the cell as text.
    expect(out.startsWith("'")).toBe(true);
    expect(out).toBe(`'${payload}`);
  });

  it("neutralises a formula that also needs quoting", () => {
    expect(csvCell('=cmd|"/c calc"!A0')).toBe('"\'=cmd|""/c calc""!A0"');
  });

  it("joins rows with CRLF and ends the file with a newline", () => {
    const csv = toCsv(["a", "b"], [
      [1, 2],
      [3, 4],
    ]);
    expect(csv).toBe("a,b\r\n1,2\r\n3,4\r\n");
  });

  it("escapes the header row too", () => {
    expect(toCsv(["full,name"], [[1]])).toContain('"full,name"');
  });
});
