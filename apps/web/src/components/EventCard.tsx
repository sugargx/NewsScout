import type { Event } from "../types";
import { EventRow } from "./EventRow";

export function EventCard({ event, snapshot = false, onOpen, onOpenRelated, selected = false }: {
  event: Event;
  snapshot?: boolean;
  onOpen?: (event: Event, opener?: HTMLElement) => void;
  onOpenRelated?: (id: string, opener?: HTMLElement, note?: "archive" | null) => void;
  selected?: boolean;
  brief?: boolean;
}) {
  return <EventRow event={event} snapshot={snapshot} onOpen={onOpen} onOpenRelated={onOpenRelated} selected={selected} headingLevel="h3"/>;
}
