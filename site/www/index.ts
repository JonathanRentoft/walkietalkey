/** www.walkietalkey.com: a permanent redirect to walkietalkey.com, keeping the path and query. */
export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    url.protocol = "https:";
    url.hostname = "walkietalkey.com";
    url.port = "";
    return Response.redirect(url.toString(), 301);
  },
};
