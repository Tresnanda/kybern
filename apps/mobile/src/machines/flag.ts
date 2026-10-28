/**
 * Merged lists across machines (machine-network design §5.3). Off until N4
 * (network pairing) lands: with it off, the app connects only to the computer
 * the user is at, opens no other socket, and reads no list a second time.
 *
 * TODO(N7 part 2): flip this on once pairing adds the other members, and drop
 * the flag when the merged lists are the only lists.
 */
export const MERGED_LISTS_ENABLED = false;
