import { useEffect, useState } from "react";

const STORAGE_KEY = "sim-simma-install-tip-dismissed";

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua);
  const notOther = !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Android/.test(ua);
  // iOS Chrome uses CriOS; Safari is WebKit without those.
  return iOS && webkit && (notOther || (/Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)));
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

export default function InstallTip() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === "1") return;
    } catch {
      // ignore
    }
    if (isStandalone()) return;
    if (!isIosSafari()) return;
    setVisible(true);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore
    }
    setVisible(false);
  };

  return (
    <aside className="install-tip" role="note" aria-label="Add to Home Screen tip">
      <div className="install-tip-body">
        <strong>Tip:</strong> Add Sim Simma to your Home Screen — tap the{" "}
        <span className="share-glyph" aria-label="Share">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 3.5a1 1 0 0 1 1 1V11h2.6a1 1 0 0 1 .7 1.7l-3.6 3.6a1 1 0 0 1-1.4 0l-3.6-3.6A1 1 0 0 1 8.4 11H11V4.5a1 1 0 0 1 1-1Z"
            />
            <path
              fill="currentColor"
              d="M5 14.5a1 1 0 0 1 1 1V18a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2.5a1 1 0 1 1 2 0V18a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-2.5a1 1 0 0 1 1-1Z"
            />
          </svg>
        </span>{" "}
        <b>Share</b> button, then <b>Add to Home Screen</b>.
      </div>
      <button type="button" className="install-tip-close" onClick={dismiss} aria-label="Dismiss tip">
        ×
      </button>
    </aside>
  );
}
