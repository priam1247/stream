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
    <nav aria-label={label} className="seg flex w-full gap-1 overflow-x-auto bg-wash/80 p-1 sm:max-w-xl">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={item.id === value ? 'page' : undefined}
          aria-pressed={item.id === value}
          onClick={() => onChange(item.id)}
          className={`min-h-11 min-w-max flex-1 px-2 text-[11px] font-semibold tracking-tight transition sm:px-3 sm:text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-600 ${
            item.id === value ? 'bg-black text-white' : 'text-muted hover:text-accent-700'
          }`}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
