export function isValidEventId(value) {
  return typeof value === "string" && value.trim() !== "" && !/[/?#\s]/.test(value);
}
