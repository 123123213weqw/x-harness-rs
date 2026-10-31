from fixtures import make_case

def cases():
    return [make_case(family,1000+f*3+i,fault) for f,family in enumerate(['duration','billing','pagination','records']) for i,fault in enumerate(['normal','transient','outage'])]
