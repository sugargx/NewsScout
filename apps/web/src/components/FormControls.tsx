import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

export function Toggle({ checked, onChange, label, text, disabled = false }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  text?: ReactNode;
  disabled?: boolean;
}) {
  const control = <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
    className={`ns-toggle${checked ? " is-on" : ""}`} onClick={() => onChange(!checked)}><span aria-hidden="true"/></button>;
  if (text === undefined) return control;
  return <div className="ns-toggle-line">{control}<span aria-hidden="true">{text}</span></div>;
}

export function WeightField({ topic, value, disabled = false, onChange }: {
  topic: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return <label className="ns-weight-field">
    <span>权重 · {value}</span>
    <input type="range" min={0} max={100} step={1} value={value} disabled={disabled} aria-label={`${topic} 的权重`}
      onChange={event => onChange(Number(event.currentTarget.value))}/>
  </label>;
}

type FieldControl = ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;

export function FormField({ label, hint, error, children, className }: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: FieldControl;
  className?: string;
}) {
  const generated = useId();
  const control = isValidElement(children) ? children : null;
  const id = control?.props.id ?? generated, hintId = `${id}-hint`, errorId = `${id}-error`;
  const describedBy = [control?.props["aria-describedby"], hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ");
  const field = control ? cloneElement(control, { id, ...(describedBy ? { "aria-describedby": describedBy } : {}), ...(error ? { "aria-invalid": true } : {}) }) : children;
  return <div className={`ns-field${error ? " has-error" : ""}${className ? " " + className : ""}`}>
    <label className="ns-field-label" htmlFor={id}>{label}</label>
    {field}
    {hint && <small id={hintId}>{hint}</small>}
    {error && <span className="ns-field-error" id={errorId} role="alert">{error}</span>}
  </div>;
}