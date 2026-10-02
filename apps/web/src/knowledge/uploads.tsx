import { failureText } from "@grasp-os/shared/errors";
import { pageMaxLimit } from "@grasp-os/shared/knowledge";
import {
  uploadErrors,
  uploadMaxBytes,
  uploadOriginalPath,
  uploadTypes,
} from "@grasp-os/shared/uploads";
import type { Upload, UploadStatus } from "@grasp-os/shared/uploads";
import { buttonVariants } from "@grasp-os/ui/components/button";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useRouter } from "@tanstack/react-router";
import {
  ArrowUpIcon,
  CircleAlertIcon,
  DownloadIcon,
  FileTextIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { isTransient, wait } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

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
  core: CoreConnection,
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
      current = await readWithin(
        core,
        async (session) => await session.uploads.get(upload.id)
      );
      onChange(current);
    } catch (error) {
      if (!isTransient(error)) {
        return { upload: current, problem: failureText(error) };
      }
    }
  }
  return settled(current)
    ? { upload: current }
    : {
        upload: current,
        problem: i18n._(
          msg`Still being read. It shows in the file list once it's ready.`
        ),
      };
};

const statusLabels: Readonly<Record<UploadStatus, MessageDescriptor>> = {
  pending: msg`Pending`,
  extracting: msg`Extracting`,
  ready: msg`Ready`,
  failed: msg`Failed`,
};

/**
 * One upload: its status, and once ready, links to its document and its
 * original. `listed` holds the documents the file list shows.
 */
const UploadRow = ({
  upload,
  problem,
  listed,
}: Followed & { listed: ReadonlySet<string> }) => {
  const { t } = useLingui();
  const { name } = upload;
  const status = i18n._(statusLabels[upload.status]);
  const ready = upload.status === "ready" && upload.documentId !== null;
  return (
    <li className="bg-card grid min-h-14 grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg border py-2 pr-2 pl-2.5 text-sm">
      <span className="text-muted-foreground grid size-10 place-items-center">
        {upload.status === "failed" ? (
          <CircleAlertIcon className="text-status-attention size-5" />
        ) : (
          <FileTextIcon className="size-5" />
        )}
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate font-medium" title={upload.name}>
          {upload.name}
        </span>
        <output className="text-muted-foreground text-xs">
          {upload.failure === null
            ? status
            : `${status}: ${upload.failure.message}`}
        </output>
        {/* The file list shows its first page only: a name that sorts past it
          opens from here. */}
        {ready &&
        upload.documentId !== null &&
        !listed.has(upload.documentId) ? (
          <p className="text-muted-foreground text-xs">
            {t`It's past the first ${pageMaxLimit} files listed: open it from here.`}
          </p>
        ) : null}
        <ErrorText>{problem}</ErrorText>
      </span>
      {ready && upload.documentId !== null ? (
        <span className="flex items-center gap-1">
          <Link
            className={buttonVariants({ size: "sm", variant: "ghost" })}
            params={{ collection: upload.collectionId }}
            search={{ doc: upload.documentId }}
            to="/knowledge/$collection"
          >
            {t`Open ${name}`}
          </Link>
          {/* Core serves it as an attachment only, to those who may read it. */}
          <a
            aria-label={t`Download ${name}`}
            className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
            download
            href={uploadOriginalPath(encodeURIComponent(upload.id))}
          >
            <DownloadIcon />
          </a>
        </span>
      ) : (
        <span />
      )}
    </li>
  );
};

/** Three sheets of paper, the drop's one picture, fanned wider under a file. */
const Sheets = ({ dragging }: { dragging: boolean }) => {
  const sheet =
    "bg-card text-muted-foreground absolute inset-0 grid origin-bottom place-items-end justify-center rounded-md border pb-1.5 shadow-xs transition-transform duration-300";
  const lines = (
    <>
      <span className="absolute top-2 left-1.75 h-0.5 w-4 rounded-full bg-current opacity-30" />
      <span className="absolute top-3.25 left-1.75 h-0.5 w-2.75 rounded-full bg-current opacity-30" />
    </>
  );
  return (
    <span
      aria-hidden="true"
      className="relative mx-auto mt-2.5 mb-3.5 block h-11 w-9"
    >
      <span
        className={
          dragging
            ? `${sheet} -translate-x-5 -rotate-[22deg]`
            : `${sheet} -translate-x-2 -rotate-10 group-hover:-translate-x-3 group-hover:-rotate-15`
        }
      >
        {lines}
      </span>
      <span
        className={
          dragging
            ? `${sheet} translate-x-5 rotate-[22deg]`
            : `${sheet} translate-x-2 rotate-10 group-hover:translate-x-3 group-hover:rotate-15`
        }
      >
        {lines}
      </span>
      <span
        className={dragging ? `${sheet} text-foreground -translate-y-2` : sheet}
      >
        {lines}
        <ArrowUpIcon className="size-3.5" strokeWidth={2} />
      </span>
    </span>
  );
};

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
  const core = useCore();
  const { busy, failure, run } = useCoreAction();
  const [followed, setFollowed] = useState<Followed[]>([]);
  const [dragging, setDragging] = useState(false);
  const { t } = useLingui();
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
      core,
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
  const accept = Object.keys(uploadTypes)
    .map((extension) => `.${extension}`)
    .join(",");
  return (
    <section aria-labelledby="uploads" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium" id="uploads">
        <Trans>Upload</Trans>
      </h2>
      <div
        className={
          dragging
            ? "group bg-muted/30 has-focus-visible:ring-ring/50 border-foreground/40 relative grid min-w-0 rounded-2xl border border-dashed has-focus-visible:ring-3"
            : "group bg-card hover:bg-muted/50 has-focus-visible:ring-ring/50 relative grid min-w-0 rounded-2xl border border-dashed has-focus-visible:ring-3"
        }
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          const into = event.relatedTarget;
          if (!(into instanceof Node && event.currentTarget.contains(into))) {
            setDragging(false);
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          for (const file of event.dataTransfer.files) {
            void upload(file);
          }
        }}
      >
        <label
          className="flex w-full cursor-pointer flex-col items-stretch justify-center rounded-2xl px-5 pt-5.5 pb-6.5 text-center text-sm"
          htmlFor={inputId}
        >
          <Sheets dragging={dragging} />
          <span className="font-medium">
            {dragging ? t`Let go to add them` : t`Drop files here`}
          </span>
          <span className="text-muted-foreground mt-1">
            {t`or choose them from your computer`}
          </span>
          <span className="text-muted-foreground pt-1.5 text-xs">
            <Trans>Upload a PDF, Word or Excel file</Trans>
          </span>
        </label>
        <input
          accept={accept}
          className="sr-only"
          disabled={busy}
          id={inputId}
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            // Empty again, so the same file can be chosen once more.
            event.target.value = "";
            for (const file of files) {
              void upload(file);
            }
          }}
          type="file"
        />
      </div>
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
