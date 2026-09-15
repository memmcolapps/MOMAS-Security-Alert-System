import { Search, X } from "lucide-react";

// One row instead of three. The old pages stacked a chip row per dimension, so
// a company with a dozen channels pushed the table below the fold and every
// chip competed for attention whether or not it was in use. Here the choices
// live in selects that stay one line wide, and only the filters actually in
// force get a visible pill.
const ACCENTS = {
  green: {
    focus: "focus-within:border-ops-green",
    pill: "border-ops-green/50 bg-green-500/10 text-ops-green",
    select: "border-ops-green/40 bg-green-500/10 text-ops-green",
  },
  sky: {
    focus: "focus-within:border-sky-400",
    pill: "border-sky-400/50 bg-sky-500/10 text-sky-300",
    select: "border-sky-400/40 bg-sky-500/10 text-sky-300",
  },
};

function labelFor(filter) {
  const match = filter.options.find((option) => String(option.value) === String(filter.value));
  return match ? match.label : String(filter.value);
}

function isActive(filter) {
  return String(filter.value) !== String(filter.neutralValue ?? "all");
}

/**
 * @param {object} props
 * @param {"green"|"sky"} [props.accent]
 * @param {string} props.search
 * @param {(value: string) => void} props.onSearchChange
 * @param {string} [props.searchPlaceholder]
 * @param {Array<{key: string, label: string, value: string, neutralValue?: string,
 *   options: Array<{value: string, label: string}>, onChange: (value: string) => void}>} [props.filters]
 * @param {string} [props.summary] Right-aligned count, e.g. "42 of 118".
 */
export function FilterBar({
  accent = "green",
  search,
  onSearchChange,
  searchPlaceholder = "Search",
  filters = [],
  summary,
}) {
  const tone = ACCENTS[accent] || ACCENTS.green;
  const activeFilters = filters.filter(isActive);

  function clearAll() {
    onSearchChange("");
    for (const filter of activeFilters) filter.onChange(String(filter.neutralValue ?? "all"));
  }

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className={`flex min-w-[200px] flex-1 items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 ${tone.focus}`}
        >
          <Search size={13} className="shrink-0 text-neutral-500" />
          <input
            className="w-full min-w-0 bg-transparent text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
          {search ? (
            <button className="shrink-0 text-neutral-500 hover:text-neutral-200" onClick={() => onSearchChange("")} aria-label="Clear search">
              <X size={12} />
            </button>
          ) : null}
        </div>

        {filters.map((filter) => (
          <select
            key={filter.key}
            aria-label={filter.label}
            title={filter.label}
            value={filter.value}
            onChange={(event) => filter.onChange(event.target.value)}
            className={`max-w-[190px] rounded-md border px-2.5 py-[7px] text-[11px] outline-none ${
              isActive(filter) ? `font-bold ${tone.select}` : "border-white/10 bg-white/[0.03] text-neutral-400"
            }`}
          >
            {filter.options.map((option) => (
              <option key={option.value} value={option.value} className="bg-[#111] text-neutral-200">
                {option.label}
              </option>
            ))}
          </select>
        ))}

        {summary ? (
          <span className="ml-auto whitespace-nowrap text-[10px] text-neutral-500">{summary}</span>
        ) : null}
      </div>

      {activeFilters.length || search ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {activeFilters.map((filter) => (
            <button
              key={filter.key}
              onClick={() => filter.onChange(String(filter.neutralValue ?? "all"))}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${tone.pill}`}
              title={`Clear ${filter.label.toLowerCase()} filter`}
            >
              <span className="opacity-70">{filter.label}:</span> {labelFor(filter)}
              <X size={10} />
            </button>
          ))}
          {search ? (
            <button
              onClick={() => onSearchChange("")}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${tone.pill}`}
              title="Clear search"
            >
              <span className="opacity-70">Search:</span> {search}
              <X size={10} />
            </button>
          ) : null}
          <button className="px-1 text-[10px] text-neutral-500 underline-offset-2 hover:text-neutral-200 hover:underline" onClick={clearAll}>
            Clear all
          </button>
        </div>
      ) : null}
    </div>
  );
}
