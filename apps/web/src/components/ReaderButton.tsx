import { Button, mergeClasses, type ButtonProps } from "@fluentui/react-components";
import { forwardRef } from "react";
import "../reader-controls.css";

type ReaderButtonProps = Omit<Extract<ButtonProps, { as?: "button" }>, "appearance" | "size" | "as"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "small" | "medium";
};

export const ReaderButton = forwardRef<HTMLButtonElement, ReaderButtonProps>(function ReaderButton({
  variant = "secondary", size = "medium", className, type = "button", ...props
}, ref) {
  return <Button {...props} title={props.title??props["aria-label"]} as="button" ref={ref} type={type} size={size}
    appearance={variant === "primary" || variant === "danger" ? "primary" : variant === "ghost" ? "subtle" : "secondary"}
    className={mergeClasses("ns-reader-button", className)} data-variant={variant} data-size={size}/>;
});
