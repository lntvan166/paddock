import { useEffect, useState } from "react";
import type { RenderMode } from "@shared/types";
import { fetchFileMeta, fileDownloadUrl, fileUrl } from "@web/api";
import { BackIcon } from "@web/components/ui/icons";

/**
 * One file, shown on a phone.
 *
 * TWO SANDBOXES, and they are not redundant. The iframe's `sandbox` attribute
 * protects THIS page from what it embeds. The response's
 * `Content-Security-Policy: sandbox` protects against the same URL being opened
 * directly, which anyone can do because the id sits in the address bar. Drop
 * either and an agent-authored HTML page becomes same-origin with paddock: able
 * to read `localStorage` and call paddock's own API with the browser's
 * credentials, which is to say, able to drive the operator's agents.
 *
 * `allow-same-origin` is absent deliberately. Adding it would return the frame
 * to paddock's origin and undo the whole arrangement.
 *
 * DOWNLOAD IS OFFERED FOR EVERY TYPE, not only the unrenderable ones. It was the
 * operator's own framing of the feature — "open or download it if I want" — and
 * it is the escape hatch when a render is wrong, which for a viewer that guesses
 * from a file extension will sometimes happen.
 *
 * Hook-free: the caller owns fetching the metadata and owns what Back means.
 */
export function FileViewer({ id, name, render, onBack }: {
  id: string;
  name: string;
  render: RenderMode;
  onBack: () => void;
}) {
  return (
    <section className="screen file-view" aria-label={`${name}`}>
      <header className="term-header">
        <button type="button" className="term-back" onClick={onBack} aria-label="Back">
          <BackIcon className="term-back-glyph" />
        </button>
        <strong className="file-title">{name}</strong>
        {/* A real link, not a fetch: `download` on an anchor is what lets iOS
            hand the file to another app, and a scripted save cannot. */}
        <a className="file-download" href={fileDownloadUrl(id)} download={name}>
          Download
        </a>
      </header>

      <div className="file-body">
        {(render === "iframe" || render === "text") && (
          <iframe
            className="file-frame"
            src={fileUrl(id)}
            sandbox=""
            title={name}
            data-tour="file-frame"
          />
        )}

        {render === "image" && <img className="file-image" src={fileUrl(id)} alt={name} />}

        {render === "download" && (
          <p className="file-note">
            This kind of file cannot be shown here. Download it to open it in
            another app.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The file route's stateful half: turn an id into a name and a render mode.
 *
 * Split from `FileViewer` the way `AgentDetail` is split from its view — the
 * markup stays testable without effects to settle, and the fetching lives in one
 * place.
 *
 * The metadata is fetched rather than passed in, because `#/file/:id` SURVIVES A
 * RELOAD. That is the reason it is a route at all, and after a refresh the id is
 * the only thing left: whatever the terminal knew when the path was tapped is
 * gone. `GET /api/files/:id/meta` exists for exactly this moment.
 *
 * Keyed on the id by the caller, so moving between two files remounts rather
 * than showing the previous file's name against the new one's bytes.
 */
export function FileScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const [meta, setMeta] = useState<{ name: string; render: RenderMode } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setMeta(null);
    setFailed(null);
    void fetchFileMeta(id)
      .then((m) => { if (live) setMeta(m); })
      .catch((err: unknown) => {
        // The server's own sentence, verbatim: it knows whether this is a stale
        // id or a file that has since moved, and those are fixed differently.
        if (live) setFailed(err instanceof Error ? err.message : "Could not open that file.");
      });
    return () => { live = false; };
  }, [id]);

  if (failed !== null) {
    return (
      <section className="screen file-view" aria-label="File">
        <header className="term-header">
          <button type="button" className="term-back" onClick={onBack} aria-label="Back">
            <BackIcon className="term-back-glyph" />
          </button>
          <strong className="file-title">File</strong>
        </header>
        <div className="file-body">
          <p className="file-note">{failed}</p>
        </div>
      </section>
    );
  }

  if (meta === null) {
    return (
      <section className="screen file-view" aria-label="File">
        <header className="term-header">
          <button type="button" className="term-back" onClick={onBack} aria-label="Back">
            <BackIcon className="term-back-glyph" />
          </button>
          <strong className="file-title">Opening…</strong>
        </header>
        <div className="file-body" />
      </section>
    );
  }

  return <FileViewer id={id} name={meta.name} render={meta.render} onBack={onBack} />;
}
