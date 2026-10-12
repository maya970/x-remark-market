const UI = {
  escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  },

  shortAddr(address) {
    return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—";
  },

  formatTime(ts) {
    return ts ? new Date(Number(ts)).toLocaleString("zh-CN", { hour12: false }) : "—";
  },

  downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
};
