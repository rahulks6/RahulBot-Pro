"""
============================================================
RahulBot Pro v7
Confidence Engine
============================================================
"""


class Confidence:

    @staticmethod
    def level(score):

        if score >= 90:
            return "⭐⭐⭐⭐⭐ Excellent"

        if score >= 80:
            return "⭐⭐⭐⭐ Strong"

        if score >= 70:
            return "⭐⭐⭐ Good"

        if score >= 60:
            return "⭐⭐ Watch"

        return "⭐ Weak"