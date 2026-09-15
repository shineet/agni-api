// A CBOR decoder covering exactly the subset App Attest uses.
//
// WHY HAND-WRITTEN. This project has no npm dependencies and that rule is worth
// keeping here, but only because of WHICH part this is. The dangerous work in
// attestation -- certificate chain validation and signature verification -- is
// done by Node's own crypto, which is reviewed code. This file only decodes a
// structure, and it is written to be STRICT: anything it does not expect throws
// rather than being guessed at, so a parsing bug fails a verification instead
// of passing one.
//
// Subset: unsigned integers, byte strings, text strings, arrays, maps.
// Anything else in an App Attest object means the object is not what it claims.

const MAJOR = {
  UNSIGNED: 0,
  BYTES: 2,
  TEXT: 3,
  ARRAY: 4,
  MAP: 5
};

function readLength(view, state, info) {
  if (info < 24) return info;
  if (info === 24) return view.getUint8(state.offset++);
  if (info === 25) { const v = view.getUint16(state.offset); state.offset += 2; return v; }
  if (info === 26) { const v = view.getUint32(state.offset); state.offset += 4; return v; }
  if (info === 27) {
    // 64-bit lengths do not occur in anything Apple sends, and accepting one
    // would mean accepting a length this decoder cannot honestly bound.
    throw new Error('CBOR: 64-bit lengths are not accepted');
  }
  throw new Error(`CBOR: bad additional info ${info}`);
}

function decodeItem(view, state, bytes) {
  if (state.offset >= bytes.length) throw new Error('CBOR: ran off the end');
  const initial = view.getUint8(state.offset++);
  const major = initial >> 5;
  const info = initial & 0x1f;

  switch (major) {
    case MAJOR.UNSIGNED:
      return readLength(view, state, info);

    case MAJOR.BYTES: {
      const length = readLength(view, state, info);
      const slice = bytes.subarray(state.offset, state.offset + length);
      if (slice.length !== length) throw new Error('CBOR: truncated byte string');
      state.offset += length;
      return slice;
    }

    case MAJOR.TEXT: {
      const length = readLength(view, state, info);
      const slice = bytes.subarray(state.offset, state.offset + length);
      if (slice.length !== length) throw new Error('CBOR: truncated text');
      state.offset += length;
      return new TextDecoder().decode(slice);
    }

    case MAJOR.ARRAY: {
      const count = readLength(view, state, info);
      const out = [];
      for (let i = 0; i < count; i += 1) out.push(decodeItem(view, state, bytes));
      return out;
    }

    case MAJOR.MAP: {
      const count = readLength(view, state, info);
      const out = {};
      for (let i = 0; i < count; i += 1) {
        const key = decodeItem(view, state, bytes);
        if (typeof key !== 'string') throw new Error('CBOR: map keys must be text here');
        out[key] = decodeItem(view, state, bytes);
      }
      return out;
    }

    default:
      throw new Error(`CBOR: unsupported major type ${major}`);
  }
}

export function decodeCBOR(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const state = { offset: 0 };
  const value = decodeItem(view, state, bytes);
  // Trailing bytes mean the input is not the single object it claimed to be.
  if (state.offset !== bytes.length) throw new Error('CBOR: trailing data');
  return value;
}
