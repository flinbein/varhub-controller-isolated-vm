export function parseDescriptor(descriptor) {
    const [specifier, protocol, name, extension, query, hash] = descriptor.match(/^(?:(\w*):)?(\.?(?:[^.?#\n]|\.(?=[^.?#\n]*\.)|\.(?=[^?#\n]*\/))*\.?)(?:\.([^?#\n]*))?(?:\?([^#\n]*))?(?:#([^\n]*))?$/) ?? (() => { throw new Error("wrong module specifier: " + descriptor); })();
    const file = [name, extension].filter(Boolean).join(".");
    return { specifier, protocol, name, extension, query, hash, file };
}
export function joinDescriptor(desc) {
    let result = "";
    if (desc.protocol)
        result += desc.protocol + ":";
    if (desc.name)
        result += desc.name;
    if (desc.extension)
        result += "." + desc.extension;
    if (desc.query)
        result += "?" + desc.query;
    if (desc.hash)
        result += "#" + desc.hash;
    return result;
}
