import { normalizeIP } from "@better-auth/core/utils/ip";

/** The IPv6 prefix that counts as one client: a home or office gets a /64. */
const ipv6ClientPrefix = 64;

/**
 * The part of a client's address that identifies it: an IPv4 address whole
 * (an IPv4-mapped IPv6 address as its IPv4 address) and an IPv6 address by
 * its /64, since anyone holding a /64 can pick any address in it. The same
 * normalisation Better Auth gives the client IP core keeps on each session.
 * Anything that isn't an IP address comes back lower-cased, as it is.
 */
export const clientAddress = (ip: string): string =>
  normalizeIP(ip, { ipv6Subnet: ipv6ClientPrefix });
