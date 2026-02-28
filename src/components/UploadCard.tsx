"use client";

import { useRef } from "react";

export function UploadCard({
  title,
  subtitle,
  busy = false,
  error = null,
  onFiles,
}: {
  title: string;
  subtitle?: string;
  busy?: boolean;
  error?: string | null;
  onFiles: (files: FileList | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  function pickFiles() {
    inputRef.current?.click();
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    onFiles(e.dataTransfer.files);
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <div className="rounded-2xl border bg-white shadow-sm">
      <div className="border-b p-5">
        <div className="text-lg font-semibold">{title}</div>
        {subtitle ? <div className="mt-1 text-sm text-gray-600">{subtitle}</div> : null}
      </div>

      <div className="p-5">
        <div onDrop={onDrop} onDragOver={onDragOver} className="rounded-2xl border border-dashed bg-gray-50 p-6">
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium text-gray-900">Drop your report here</div>
              <div className="mt-1 text-xs text-gray-600">CSV • Processed in-browser • No storage</div>
            </div>

            <button
              type="button"
              onClick={pickFiles}
              disabled={busy}
              className="inline-flex items-center rounded-xl bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "Parsing…" : "Choose file"}
            </button>

            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              onChange={(e) => onFiles(e.target.files)}
              className="hidden"
            />
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
        ) : null}
      </div>
    </div>
  );
}