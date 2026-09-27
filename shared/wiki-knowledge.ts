export type WikiKnowledgeSource = {
  id: string;
  title: string;
  filename: string;
  kind: "markdown" | "pdf";
};

export function createWikiKnowledgeSource(filename: string): WikiKnowledgeSource | null {
  if (filename.includes("/") || filename.includes("\\") || filename.startsWith(".")) return null;
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (extension !== "md" && extension !== "pdf") return null;
  const title = filename.slice(0, filename.lastIndexOf(".")).replace(/\s+/g, " ").trim();
  if (!title) return null;
  return {
    id: filename,
    title,
    filename,
    kind: extension === "md" ? "markdown" : "pdf",
  };
}

export function isWikiKnowledgeSources(value: unknown): value is WikiKnowledgeSource[] {
  return Array.isArray(value) && value.every((item) =>
    Boolean(item && typeof item === "object" && "id" in item && "title" in item && "filename" in item && "kind" in item
      && typeof item.id === "string" && typeof item.title === "string" && typeof item.filename === "string"
      && (item.kind === "markdown" || item.kind === "pdf")));
}
