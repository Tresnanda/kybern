/** Read only complete HTTPS links from a sign-in terminal's bounded output.
 * The caller opens a link only after an explicit user action. */
export function connectorLoginOutput() {
  let text = "";
  const decoder = new TextDecoder();
  return (base64: string): string | null => {
    try {
      text = (
        text +
        decoder.decode(
          Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
          { stream: true },
        )
      ).slice(-16_384);
    } catch {
      return null;
    }
    // Remove terminal color/OSC sequences before extracting line-delimited URLs.
    const plain = text
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
    const matches = plain.match(/https:\/\/[^\s<>"']+(?=\s)/g) ?? [];
    for (const match of matches.reverse()) {
      try {
        const url = new URL(match);
        if (
          url.protocol === "https:" &&
          url.hostname &&
          !url.username &&
          !url.password
        )
          return url.href;
      } catch {
        /* Wait for a complete provider URL. */
      }
    }
    return null;
  };
}
