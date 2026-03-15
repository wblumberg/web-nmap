function decodeGrid(view, headerOffset, payloadOffset) {

    let o = headerOffset

    const nx = view.getUint32(o, true); o += 4
    const ny = view.getUint32(o, true); o += 4

    const scale = view.getFloat32(o, true); o += 4
    const offset = view.getFloat32(o, true); o += 4

    const packing = view.getUint8(o)

    let array

    if (packing === 1) {
        array = new Int16Array(view.buffer, payloadOffset, nx * ny)
    }

    if (packing === 2) {
        array = new Int32Array(view.buffer, payloadOffset, nx * ny)
    }

    if (packing === 3) {
        array = new Float32Array(view.buffer, payloadOffset, nx * ny)
    }

    return {
        type: "grid",
        nx,
        ny,
        scale,
        offset,
        data: array
    }
}