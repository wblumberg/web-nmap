function decodeFeatures(view, headerOffset, payloadOffset) {

    let o = headerOffset

    const featureCount = view.getUint32(o, true); o += 4
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

    const features = []

    for (let i = 0; i < featureCount; i++) {

        const geomType = view.getUint8(p); p += 1
        p += 1

        const attrCount = view.getUint16(p, true); p += 2
        const vertexCount = view.getUint32(p, true); p += 4

        const vertices = []

        for (let v = 0; v < vertexCount; v++) {

            const lat = view.getInt32(p, true) * 1e-6; p += 4
            const lon = view.getInt32(p, true) * 1e-6; p += 4

            vertices.push([lat, lon])
        }

        const attrs = []

        for (let a = 0; a < attrCount; a++) {

            const field = fields[a]

            let val

            if (field.size === 4) {
                val = view.getFloat32(p, true)
            } else if (field.size === 2) {
                val = view.getInt16(p, true)
            } else {
                val = view.getInt8(p)
            }

            p += field.size

            attrs.push(val)
        }

        features.push({
            geometryType: geomType,
            vertices,
            attributes: attrs
        })
    }

    return {
        type: "features",
        features
    }
}