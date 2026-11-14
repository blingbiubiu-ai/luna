import { extname } from "node:path";

export function inferMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
