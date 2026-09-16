"use client";

// The document library: what this company's own filings say, and whatever you bring to it.
//
// Upload an annual report, a transcript or a note, or let the platform fetch this company's recent filings and
// read them in full. Everything read here is searched when you ask a question, and an answer that uses a
// document cites it by page.
import clsx from "clsx";
import { FileText, Loader2, Trash2, Upload } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { AiDisclosure } from "@/components/Disclosure";
import { Button, Card, CardBody, CardHeader, ErrorNote, Skeleton } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { dateOnly, int } from "@/lib/format";

interface Doc {
  id: string; title: string; kind: string; source: string | null; url: string | null;
  pages: number; chars: number; chunks: number; note: string | null; added_at: string;
}
interface LibraryData { symbol: string | null; documents: Doc[]; library: { documents: number; chunks: number; embedded: number } }

const KIND_LABEL: Record<string, string> = { upload: "Uploaded", filing: "Exchange filing", report: "Report" };

export function Library({ symbol, company }: { symbol: string; company: string | null }) {
  const path = `/api/v2/company/${encodeURIComponent(symbol)}/library`;
  const { data, error, reload } = useApi<LibraryData>(path);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setProblem(null);
    for (const file of Array.from(files)) {
      setBusy(`Reading ${file.name}…`);
      try {
        const body = new FormData();
        body.append("file", file);
        // FormData sets its own content type with the multipart boundary.
        await api(path, { method: "POST", body, headers: {} as Record<string, string> });
      } catch (e) {
        setProblem(`${file.name}: ${(e as Error).message}`);
      }
    }
    setBusy(null);
    reload();
  }, [path, reload]);

  const fetchFilings = async () => {
    setProblem(null);
    setBusy("Fetching this company's filings and reading them…");
    try {
      await api(`${path}?fetch=8`, { method: "POST" });
    } catch (e) {
      setProblem((e as Error).message);
    }
    setBusy(null);
    reload();
  };

  const drop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    await upload(e.dataTransfer.files);
  };

  return (
    <Card>
      <CardHeader
        title="Document library"
        subtitle={data?.library.documents
          ? `${data.documents.length} document${data.documents.length === 1 ? "" : "s"} read for ${company ?? symbol}; ${int(data.library.chunks)} passages searched when you ask a question.`
          : "Read a filing, an annual report or your own notes, then ask questions about what they say."}
        actions={<Button onClick={fetchFilings} disabled={Boolean(busy)}>Read recent filings</Button>}
      />
      <CardBody className="space-y-4">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
          onClick={() => input.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") input.current?.click(); }}
          className={clsx("flex cursor-pointer flex-col items-center gap-1.5 rounded-2xl border-2 border-dashed p-6 text-center transition",
            dragging ? "border-indigo-400 bg-indigo-50/60 dark:bg-indigo-500/10" : "border-slate-300 hover:border-indigo-300 dark:border-slate-700")}
        >
          {busy ? <Loader2 size={20} className="animate-spin text-indigo-600" /> : <Upload size={20} className="text-slate-400" />}
          <p className="text-sm font-medium">{busy ?? "Drop a PDF or Word file here, or click to choose one"}</p>
          <p className="text-xs text-slate-500">PDF, DOCX, TXT, CSV or Markdown · up to 12 MB · a scanned PDF with no text layer cannot be read</p>
          <input ref={input} type="file" multiple accept=".pdf,.docx,.txt,.md,.csv,.json" className="hidden"
            onChange={(e) => upload(e.target.files)} aria-label="Choose documents to read" />
        </div>

        {problem && <ErrorNote message={problem} />}
        {error && !data && <ErrorNote message={`The library could not load: ${error}`} onRetry={reload} />}
        {!data && !error && <Skeleton className="h-16 w-full" />}

        {data?.documents.length ? (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.documents.map((doc) => (
              <li key={doc.id} className="flex items-start gap-3 py-2.5">
                <FileText size={16} className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={doc.title}>{doc.title}</p>
                  <p className="text-xs text-slate-500">
                    {KIND_LABEL[doc.kind] ?? doc.kind} · {doc.pages} page{doc.pages === 1 ? "" : "s"} · {doc.chunks} passages · read {dateOnly(doc.added_at)}
                    {doc.url && <> · <a href={doc.url} target="_blank" rel="noopener noreferrer" className="text-indigo-700 hover:underline dark:text-indigo-300">original</a></>}
                  </p>
                </div>
                <button type="button" aria-label={`Remove ${doc.title}`} title="Remove from the library"
                  onClick={async () => { await api(`${path}?id=${doc.id}`, { method: "DELETE" }).catch((e) => setProblem((e as Error).message)); reload(); }}
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10">
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          data && <p className="text-sm text-slate-500">Nothing read yet. Use &ldquo;Read recent filings&rdquo; to pull this company&apos;s own announcements, or drop a document above.</p>
        )}

        <AiDisclosure kind="retrieval" />
      </CardBody>
    </Card>
  );
}
