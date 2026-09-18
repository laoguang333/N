export function createRequestScope() {
  let generation = 0;
  let controller = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      return { generation: ++generation, signal: controller.signal };
    },
    isCurrent(ticket) {
      return ticket.generation === generation && !ticket.signal.aborted;
    },
    invalidate() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  };
}
