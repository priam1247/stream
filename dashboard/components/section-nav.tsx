'use client';

interface SectionNavProps<T extends string> {
  label: string;
  items: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

/** Compact, touch-friendly navigation for related pages within a section. */
export function SectionNav<T extends string>({ label, items, value, onChange }: SectionNavProps<T>) {
  return (
    <nav aria-label={label} className="flex w-full gap-1 rounded-2xl border border-slate-200 bg-slate-100/80 p-1 sm:max-w-xl">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={item.id === value ? 'page' : undefined}
          onClick={() => onChange(item.id)}
          className={`min-h-11 min-w-0 flex-1 rounded-xl px-1 text-[11px] font-semibold tracking-tight transition sm:px-1.5 sm:text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${
            item.id === value ? 'bg-white text-teal-800 shadow-sm' : 'text-slate-600 hover:text-teal-700'
          }`}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
