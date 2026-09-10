export function formatStartedWaiting(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
}

export function formatWaitingDuration(minutes: number): string {
  const elapsedMinutes = Math.max(0, Math.floor(minutes));
  const days = Math.floor(elapsedMinutes / 1440);
  const hours = Math.floor((elapsedMinutes % 1440) / 60);
  const remainingMinutes = elapsedMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (remainingMinutes || parts.length === 0) {
    parts.push(`${remainingMinutes} ${remainingMinutes === 1 ? "minute" : "minutes"}`);
  }
  return parts.join(" ");
}
