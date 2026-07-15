"""
============================================================
RahulBot Pro v12
Performance Tracker
============================================================
"""


class Performance:

    def __init__(self):

        self.total = 0
        self.wins = 0
        self.losses = 0

        self.gross_profit = 0
        self.gross_loss = 0

    def update(self, trade):

        self.total += 1

        if trade.pnl > 0:

            self.wins += 1

            self.gross_profit += trade.pnl

        else:

            self.losses += 1

            self.gross_loss += abs(trade.pnl)

    @property
    def net_profit(self):

        return self.gross_profit - self.gross_loss

    @property
    def win_rate(self):

        if self.total == 0:

            return 0

        return round(

            (self.wins / self.total) * 100,

            2

        )

    @property
    def average_win(self):

        if self.wins == 0:

            return 0

        return round(

            self.gross_profit / self.wins,

            2

        )

    @property
    def average_loss(self):

        if self.losses == 0:

            return 0

        return round(

            self.gross_loss / self.losses,

            2

        )

    @property
    def profit_factor(self):

        if self.gross_loss == 0:

            return 0

        return round(

            self.gross_profit / self.gross_loss,

            2

        )

    def print_report(self):

        print()

        print("=" * 60)

        print("RAHULBOT PERFORMANCE")

        print("=" * 60)

        print()

        print(f"Total Trades : {self.total}")

        print(f"Wins         : {self.wins}")

        print(f"Losses       : {self.losses}")

        print()

        print(f"Win Rate     : {self.win_rate}%")

        print()

        print(f"Gross Profit : ₹{self.gross_profit:.2f}")

        print(f"Gross Loss   : ₹{self.gross_loss:.2f}")

        print(f"Net Profit   : ₹{self.net_profit:.2f}")

        print()

        print(f"Average Win  : ₹{self.average_win:.2f}")

        print(f"Average Loss : ₹{self.average_loss:.2f}")

        print()

        print(f"Profit Factor: {self.profit_factor}")

        print("=" * 60)