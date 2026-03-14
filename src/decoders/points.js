function decodePoints(view, headerOffset, payloadOffset) {

    let o = headerOffset

    const pointCount = view.getUint32(o, true); o += 4
    const fieldCount = view.getUint16(o, true); o += 2
    o += 2

    const fields = []

    for (let i = 0; i < fieldCount; i++) {

        const type = view.getUint8(o); o += 1
        const size = view.getUint8(o); o += 1
        o += 2

        fields.push({type, size})
    }

    let p = payloadOffset

    const points = new Array(pointCount)

    for (let i = 0; i < pointCount; i++) {

        const lat = view.getInt32(p, true) * 1e-6; p += 4
        const lon = view.getInt32(p, true) * 1e-6; p += 4

        const attrs = []

        for (const f of fields) {

            let val

            if (f.size === 4) {
                val = view.getFloat32(p, true)
            } else if (f.size === 2) {
                val = view.getInt16(p, true)
            } else if (f.size === 1) {
                val = view.getInt8(p)
            }

            p += f.size

            attrs.push(val)
        }

        points[i] = {
            lat,
            lon,
            attrs
        }
    }

    return {
        type: "points",
        fields,
        points
    }
}