"""
============================================================
RahulBot Pro v5
Progress Bar
============================================================
"""


class Progress:

    @staticmethod
    def show(current, total):

        width = 30

        filled = int(width * current / total)

        bar = "█" * filled + "-" * (width - filled)

        percent = current / total * 100

        print(
            f"\r[{bar}] {current}/{total} ({percent:.1f}%)",
            end=""
        )