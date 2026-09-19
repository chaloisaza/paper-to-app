import { memo, useRef } from "react";

interface SourcePickerProps {
  /** URLs under /samples/. An empty list hides the sample strip. */
  samples: string[];
  disabled: boolean;
  onFile: (file: File) => void;
  onSample: (url: string) => void;
}

function sampleName(url: string): string {
  const file = url.split("/").pop() ?? url;
  let name = file;
  try {
    name = decodeURIComponent(file);
  } catch {
    // keep the raw file name
  }
  return name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ");
}

export const SourcePicker = memo(function SourcePicker({ samples, disabled, onFile, onSample }: SourcePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="flex h-11 shrink-0 items-center gap-2 rounded-xl bg-white/5 px-4 text-sm font-medium text-white/85 ring-1 ring-white/10 transition duration-200 enabled:hover:bg-white/10 enabled:hover:ring-white/20 disabled:opacity-40"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" />
        </svg>
        Upload image
      </button>

      {samples.length > 0 && (
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="hidden shrink-0 text-[0.65rem] font-semibold tracking-[0.2em] text-white/35 uppercase 2xl:block">Samples</span>
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-2 overflow-x-auto p-0.5 [mask-image:linear-gradient(90deg,#000_calc(100%-1.5rem),transparent)]">
            {samples.map((url) => (
              <button
                key={url}
                type="button"
                disabled={disabled}
                onClick={() => onSample(url)}
                title={`Use sample: ${sampleName(url)}`}
                className="h-11 w-[3.75rem] shrink-0 overflow-hidden rounded-lg bg-paper/10 ring-1 ring-white/10 transition duration-200 enabled:hover:-translate-y-0.5 enabled:hover:ring-paper/70 disabled:opacity-40"
              >
                <img src={url} alt={sampleName(url)} loading="lazy" draggable={false} className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
