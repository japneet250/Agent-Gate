"""Red team — adversarial probing at the decision boundary.

The existing eval suite asks "does the firewall agree with a human's label".
Useful, but labels on borderline cases are opinions, and an opinion is a weak
oracle for a case that is genuinely 50/50.

This asks harder questions that do not need an opinion, because the ground truth
comes from how the case is CONSTRUCTED:

  ladders     one variable moved across a boundary — refund $99, $199, $499,
              $501, $5,000. The exact label of any rung is arguable. The SHAPE
              is not: decisions must never get looser as the amount rises.

  pairs       two actions differing in one meaningful way, where the direction
              of the difference is certain. `DELETE ... WHERE id = 42` is
              strictly safer than `DELETE FROM users`. Whatever each is judged,
              the safer one must not be judged more harshly.

  repeats     the identical action twice. Any difference is the firewall
              contradicting itself.

  injections  an attempt to talk the judge out of its verdict, attached to a
              payload whose verdict is already known. The injected text must
              not change the outcome.

A monotonicity violation is a defect you can point at without arguing about
where the threshold belongs — which is what makes this a better bug-finder than
accuracy against a label set.
"""

from .probes import Case, Ladder, Pair, build_suite
from .run import RedTeamReport, run_redteam

__all__ = ["Case", "Ladder", "Pair", "build_suite", "RedTeamReport", "run_redteam"]
