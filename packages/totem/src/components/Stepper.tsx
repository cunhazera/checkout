interface Props {
  value: number;
  onChange: (next: number) => void;
  /** The confirm sheet clamps at 1; the basket removes the line at 0. */
  min?: number;
  max?: number;
}

export function Stepper({ value, onChange, min = 1, max }: Props) {
  const canDecrease = value > min - 1;
  const canIncrease = max === undefined || value < max;

  return (
    <div className="tp-stepper">
      <button
        type="button"
        className="tp-step tp-step-minus"
        onClick={() => onChange(value - 1)}
        disabled={!canDecrease}
        aria-label="Decrease quantity"
      >
        −
      </button>
      <span className="tp-count" role="status" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className="tp-step tp-step-plus"
        onClick={() => onChange(value + 1)}
        disabled={!canIncrease}
        aria-label="Increase quantity"
      >
        +
      </button>
    </div>
  );
}
