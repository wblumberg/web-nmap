function decodeContours(view, headerOffset, payloadOffset) {

    let o = headerOffset

    const level = view.getFloat32(o, true); o += 4
    const memberCount = view.getUint16(o, true); o += 2
    const contourCount = view.getUint16(o, true); o += 2

    let p = payloadOffset

    const contours = []

    for (let i = 0; i < contourCount; i++) {

        const member = view.getUint16(p, true); p += 2
        p += 2

        const vcount = view.getUint32(p, true); p += 4

        const vertices = []

        for (let j = 0; j < vcount; j++) {

            const lat = view.getInt32(p, true) * 1e-6; p += 4
            const lon = view.getInt32(p, true) * 1e-6; p += 4

            vertices.push([lat, lon])
        }

        contours.push({
            member,
            vertices
        })
    }

    return {
        type: "contours",
        level,
        contours
    }
}