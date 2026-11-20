const SEGMENTS = ['text', 'image', 'record', 'file', 'video', 'forward', 'at', 'reply', 'face', 'json', 'markdown'];
const DOWNLOADS = ['image', 'record', 'file', 'video', 'forward'];

function direction(kinds, supported) {
  return Object.fromEntries(kinds.map(kind => [kind, supported.includes(kind)]));
}

/** The runtime owns all contract v3 capability semantics. */
export function describeCapabilities(kernel) {
  const sendSegments = kernel.sendSegments ?? ['text', 'image'];
  const recvSegments = kernel.recvSegments ?? ['text', 'image', 'face', 'at', 'reply', 'record'];
  const downloadSegments = typeof kernel.media === 'function' ? kernel.downloadSegments ?? ['image', 'record'] : [];
  const send = direction(SEGMENTS, sendSegments);
  const recv = direction(SEGMENTS, recvSegments);
  const download = direction(DOWNLOADS, downloadSegments);
  const capabilities = {
    privateMessage: typeof kernel.send === 'function' && send.text,
    groupMessage: typeof kernel.send === 'function' && send.text,
    send, recv, download,
    mediaImage: send.image && recv.image,
    mediaRecord: send.record && recv.record,
    mediaVideo: send.video && recv.video,
    mediaFile: send.file && recv.file,
    mediaForward: send.forward && recv.forward,
    reply: send.reply,
    at: send.at && recv.at,
    face: send.face && recv.face,
    forward: send.forward && recv.forward,
    json: send.json && recv.json,
    markdown: send.markdown && recv.markdown,
    recall: typeof kernel.recall === 'function',
    friendList: typeof kernel.friends === 'function',
    groupList: typeof kernel.groups === 'function',
    groupInfo: typeof kernel.groups === 'function',
    strangerInfo: typeof kernel.stranger === 'function',
    groupMemberInfo: typeof kernel.groupMember === 'function',
    groupMemberList: typeof kernel.groupMembers === 'function',
    messageQuery: typeof kernel.getMessage === 'function',
    requestHandle: typeof kernel.handleRequest === 'function',
    mediaDownload: downloadSegments.length > 0,
    processControl: false,
    qrLogin: typeof kernel.currentQr === 'function',
    quickLogin: Boolean(kernel.quickLoginSupported),
    passwordLogin: Boolean(kernel.passwordLoginEnabled),
    logout: Boolean(kernel.logoutSupported),
  };
  // Old clients retain their feature-list contract; v3 clients read capabilities.
  const features = Object.fromEntries(Object.entries(capabilities).filter(([, value]) => typeof value === 'boolean'));
  for (const kind of ['image', 'record', 'video', 'file', 'forward']) {
    features['media' + kind[0].toUpperCase() + kind.slice(1)] = send[kind] || recv[kind];
  }
  return { capabilities, features, sendSegments, recvSegments, downloadSegments };
}
