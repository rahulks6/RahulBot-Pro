"""
============================================================
RahulBot Pro v8
Paper Engine Test
============================================================
"""

from paper.engine import PaperEngine


def main():

    engine = PaperEngine(

        capital=5000,

        risk_percent=1

    )

    engine.execute(

        symbol="TCS",

        stop_loss=2180

    )


if __name__ == "__main__":

    main()