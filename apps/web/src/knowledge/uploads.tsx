import { messageOf } from "@grasp-os/shared/errors";
import { pageMaxLimit } from "@grasp-os/shared/knowledge";
import {
  uploadErrors,
  uploadMaxBytes,
  uploadOriginalPath,
  uploadTypes,
} from "@grasp-os/shared/uploads";
import type { Upload, UploadStatus } from "@grasp-os/shared/uploads";
import { Input } from "@grasp-os/ui/components/input";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";

import { isTransient, wait, withSession, withTimeout } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Uploading a file into a collection, and following it: core answers at
// once with the upload `pending`, and extracts its text in the background,
// so the page asks again, less often the longer it takes, until it's
// ready (a version of the document at the file's name, with a link to its
// original) or failed, with core's reason. Only the person who uploaded a
// file can follow it, and only while this page stays open: leaving it
// stops the asking.

/** How long to wait before asking again, each time; the last one repeats. */
const followDelaysMs = [500, 1000, 2000, 3000] as const;

/**
 * How long to follow one upload before leaving it: an extraction that
 * keeps failing for a moment retries for a few minutes before it fails.
 */
const followForMs = 10 * 60 * 1000;

const settled = ({ status }: Upload): boolean =>
  status === "ready" || status === "failed";

interface Followed {
  upload: Upload;
  /** Why the page stopped following it before it settled. */
  problem?: string;
}

/**
 * Asks core for `upload` until it has settled, for `followForMs` at most,
 * or until `following` says to stop, telling `onChange` each time it
 * answers. Core out of reach for a moment only costs a turn; a refusal
 * ends it, with core's reason.
 */
const follow = async (
  upload: Upload,
  onChange: (upload: Upload) => void,
  following: () => boolean
): Promise<Followed> => {
  const until = Date.now() + followForMs;
  let current = upload;
  let turn = 0;
  while (!settled(current) && Date.now() < until && following()) {
    const delay =
      followDelaysMs[Math.min(turn, followDelaysMs.length - 1)] ?? 0;
    // oxlint-disable-next-line no-await-in-loop -- backing off between asks
    await wait(delay);
    turn += 1;
    // The page may have closed while waiting: then nobody asks.
    if (!following()) {
      break;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one ask at a time
      current = await withSession(
        async (session) => await withTimeout(session.uploads.get(upload.id))
      );
      onChange(current);
    } catch (error) {
      if (!isTransient(error)) {
        return { upload: current, problem: messageOf(error) };
      }
    }
  }
  return settled(current)
    ? { upload: current }
    : {
        upload: current,
        problem: "Still being read. It shows in the file list once it's ready.",
      };
};

const statusLabels: Readonly<Record<UploadStatus, string>> = {
  pending: "Pending",
  extracting: "Extracting",
  ready: "Ready",
  failed: "Failed",
};

/**
 * One upload: its status, and once ready, links to its document and its
 * original. `listed` holds the documents the file list shows.
 */
const UploadRow = ({
  upload,
  problem,
  listed,
}: Followed & { listed: ReadonlySet<string> }) => (
  <li className="flex flex-col gap-1 text-sm">
    <span className="flex flex-wrap items-center gap-2">
      <span>{upload.name}</span>
      <output>
        {upload.failure === null
          ? statusLabels[upload.status]
          : `${statusLabels[upload.status]}: ${upload.failure.message}`}
      </output>
      {upload.status === "ready" && upload.documentId !== null ? (
        <>
          <Link
            className="underline"
            params={{ collection: upload.collectionId }}
            search={{ doc: upload.documentId }}
            to="/knowledge/$collection"
          >
            {`Open ${upload.name}`}
          </Link>
          {/* Core serves it as an attachment only, to those who may read it. */}
          <a
            className="underline"
            download
            href={uploadOriginalPath(encodeURIComponent(upload.id))}
          >
            {`Download ${upload.name}`}
          </a>
        </>
      ) : null}
    </span>
    {/* The file list shows its first page only: a name that sorts past it
        opens from here. */}
    {upload.status === "ready" &&
    upload.documentId !== null &&
    !listed.has(upload.documentId) ? (
      <p className="text-muted-foreground">
        {`It's past the first ${pageMaxLimit} files listed: open it from here.`}
      </p>
    ) : null}
    <ErrorText>{problem}</ErrorText>
  </li>
);

/**
 * Uploading files into the collection `collectionId`, and their status;
 * `listed` holds the documents the file list shows.
 */
export const Uploads = ({
  collectionId,
  listed,
}: {
  collectionId: string;
  listed: ReadonlySet<string>;
}) => {
  const router = useRouter();
  const inputId = useId();
  const { busy, failure, run } = useCoreAction();
  const [followed, setFollowed] = useState<Followed[]>([]);
  // Whether the page is still open: nobody sees the status once it isn't.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const update = ({ upload, problem }: Followed): void => {
    setFollowed((all) =>
      all.map((entry) =>
        entry.upload.id === upload.id ? { upload, problem } : entry
      )
    );
  };
  const upload = async (file: File): Promise<void> => {
    const started = await run(async (session) => {
      // Refused here, as core would, before reading and sending it all:
      // the size the browser reports only saves the trip. Core checks the
      // bytes that arrive.
      if (file.size > uploadMaxBytes) {
        throw uploadErrors.create("upload.too_large");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      return await session.uploads.upload({
        collectionId,
        name: file.name,
        bytes,
      });
    });
    if (started === undefined) {
      return;
    }
    setFollowed((all) => [{ upload: started }, ...all]);
    const end = await follow(
      started,
      (news) => {
        update({ upload: news });
      },
      () => open.current
    );
    if (!open.current) {
      return;
    }
    update(end);
    if (end.upload.status === "ready") {
      // The file list shows the new document, or its new version.
      await router.invalidate({ sync: true });
    }
  };
  return (
    <section aria-labelledby="uploads" className="flex flex-col gap-2">
      <h3 className="font-medium" id="uploads">
        Upload
      </h3>
      <label className="text-sm" htmlFor={inputId}>
        Upload a PDF, Word or Excel file
      </label>
      <Input
        accept={Object.keys(uploadTypes)
          .map((extension) => `.${extension}`)
          .join(",")}
        disabled={busy}
        id={inputId}
        onChange={(event) => {
          const [file] = event.target.files ?? [];
          // Empty again, so the same file can be chosen once more.
          event.target.value = "";
          if (file !== undefined) {
            void upload(file);
          }
        }}
        type="file"
      />
      <ErrorText>{failure}</ErrorText>
      {followed.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {followed.map((entry) => (
            <UploadRow key={entry.upload.id} listed={listed} {...entry} />
          ))}
        </ul>
      )}
    </section>
  );
};
