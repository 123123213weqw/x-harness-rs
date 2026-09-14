"""Extension of bounded lab collector, not a production bridge."""
from urllib.parse import urlsplit, parse_qs
import collector

collector.files['/expanded.html'] = ('expanded.html', 'text/html; charset=utf-8')

class ExpandedHandler(collector.Handler):
    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == '/expanded.html':
            query = parse_qs(url.query)
            if (set(query) != {'case'} or len(query['case']) != 1
                    or query['case'][0] not in ('filter', 'scroll-detail', 'modal', 'slow-layout')):
                return self.send(b'Invalid scenario', status=400)
            self.path = url.path
        return super().do_GET()

if __name__ == '__main__':
    collector.main(ExpandedHandler)
