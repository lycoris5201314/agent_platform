export function shouldApplyTaskResponse(activeTaskId: string | null, requestedTaskId: string): boolean {
  return activeTaskId === requestedTaskId;
}
