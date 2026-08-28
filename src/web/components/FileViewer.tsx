import type { RenderMode } from "@shared/types";
import { fileDownloadUrl, fileUrl } from "@web/api";
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
