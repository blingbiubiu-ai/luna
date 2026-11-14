interface ClipboardNavigator {
  readonly clipboard?: {
    writeText(text: string): Promise<void>;
  };
}

interface FallbackDocument {
  readonly body?: {
    appendChild(node: unknown): unknown;
    removeChild?(node: unknown): unknown;
  };
  createElement(name: string): unknown;
  execCommand?(command: string): boolean;
}

interface FallbackTextArea {
  value: string;
  readonly style?: {
    position?: string;
    left?: string;
    top?: string;
    opacity?: string;
  };
  setAttribute?(name: string, value: string): void;
  focus?(): void;
  select?(): void;
  remove?(): void;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard = (globalThis as { navigator?: ClipboardNavigator })
    .navigator?.clipboard;
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Remote HTTP dashboards are not secure contexts, so browsers can reject
      // Clipboard API writes even when the copy action came from a click.
    }
  }

  return copyTextWithHiddenTextArea(text);
}

function copyTextWithHiddenTextArea(text: string): boolean {
  const documentRef = (globalThis as { document?: FallbackDocument }).document;
  if (!documentRef?.body) {
    return false;
  }

  const textarea = documentRef.createElement("textarea") as FallbackTextArea;
  textarea.value = text;
  textarea.setAttribute?.("readonly", "");
  if (textarea.style) {
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    textarea.style.opacity = "0";
  }

  documentRef.body.appendChild(textarea);
  try {
    textarea.focus?.();
    textarea.select?.();
    return documentRef.execCommand?.("copy") === true;
  } finally {
    if (textarea.remove) {
      textarea.remove();
    } else {
      documentRef.body.removeChild?.(textarea);
    }
  }
}
