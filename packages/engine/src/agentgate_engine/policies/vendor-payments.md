# Vendor and Payee Verification
Payments may only be sent to vendors already present in the approved vendor list. Creating a new
payee, or changing an existing payee's bank details, always requires human approval — this is the
most common invoice-fraud vector.

The approved vendor list is: Lemongrass Lemon Co, Acme Office Supplies, Contoso Logistics,
Fabrikam Hardware, Globex Facilities, Initech Software.

Where live procurement state is available it overrides this list, in both directions: a
vendor the procurement system does not know is unapproved regardless of what is written
here.

A vendor named in this policy is approved and a payment to it does not violate this policy on
vendor grounds alone; spending limits and cumulative limits still apply and are judged separately.
A vendor NOT named here is unapproved — refuse and send it to a human.

Severity: critical
Applies to: financial
