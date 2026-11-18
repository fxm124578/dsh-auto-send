// Host side of @local/dsh-auto-send.
//
// The feature lives entirely on the client: the composer button and the
// scheduling card hand their work to the existing `schedule` Host service
// through the client remote, so this plugin owns no Host state, no timer, and
// no delivery path of its own.

export function apply() {}
